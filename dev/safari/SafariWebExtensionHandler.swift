/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Answers browser.runtime.sendNativeMessage from the extension. Safari does not let an extension read the
// clipboard, so the extension asks the app extension, which can. On macOS it also starts the app, which serves
// the Yomitan API (AppDelegate.swift), when the extension needs it.
// dev/bin/build-safari-app.js puts this file in place of the one Xcode's converter generates.

import SafariServices
#if os(macOS)
import AppKit
#else
import UIKit
#endif

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    // iOS asks the user each time the clipboard is read while it holds something another app copied, unless
    // they allowed Yomitan to paste in Settings, and the clipboard monitor reads it several times a second.
    // So what was read is kept until the clipboard changes; checking whether it changed does not ask.
    private static let lock = NSLock()
    private static var text: (changeCount: Int, value: String)?
    private static var image: (changeCount: Int, value: String?)?

    // The app supports systems older than the constant, which use the same key.
    private static var messageKey: String {
        if #available(iOS 15.0, macOS 11.0, *) {
            return SFExtensionMessageKey
        }
        return "message"
    }

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[Self.messageKey] as? [String: Any]

        let response: [String: Any]
        switch message?["action"] as? String {
        case "getClipboardText":
            response = ["text": Self.clipboardText()]
        case "getClipboardImage":
            response = ["image": Self.clipboardImage() ?? NSNull()]
        #if os(macOS)
        case "startApiServer":
            response = Self.startApiServer(port: message?["port"] as? Int ?? 19633)
        #endif
        default:
            response = ["error": "Unsupported message"]
        }

        let item = NSExtensionItem()
        item.userInfo = [Self.messageKey: response]
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    private static func clipboardText() -> String {
        lock.lock()
        defer { lock.unlock() }
        #if os(macOS)
        let pasteboard = NSPasteboard.general
        let changeCount = pasteboard.changeCount
        if let text, text.changeCount == changeCount { return text.value }
        let value = pasteboard.string(forType: .string) ?? ""
        #else
        let pasteboard = UIPasteboard.general
        let changeCount = pasteboard.changeCount
        if let text, text.changeCount == changeCount { return text.value }
        let value = pasteboard.hasStrings ? (pasteboard.string ?? "") : ""
        #endif
        text = (changeCount, value)
        return value
    }

    #if os(macOS)
    /// Starts the app that holds this extension, without a window, to serve the Yomitan API on the port, or has
    /// the running app serve on it.
    private static func startApiServer(port: Int) -> [String: Any] {
        // The app extension is at Yomitan.app/Contents/PlugIns/<name>.appex
        let appUrl = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        // The sandbox does not let the app extension read the app's bundle, but the app extension's identifier is the
        // app's followed by its own name.
        guard let extensionIdentifier = Bundle.main.bundleIdentifier, let dot = extensionIdentifier.lastIndex(of: ".") else {
            return ["error": "The app was not found"]
        }
        let bundleIdentifier = String(extensionIdentifier[..<dot])
        if !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty {
            // Sandboxed processes can only send a notification's object, and the app's AppDelegate.swift reads it.
            // The app then serves, if the user opened it, or serves on that port.
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("org.yomitan.api.port"), object: String(port), userInfo: nil, deliverImmediately: true)
            return ["started": false]
        }
        guard #available(macOS 10.15, *) else {
            return ["error": "The Yomitan API needs macOS 10.15 or later"]
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        // The app serves the API without a window when it starts hidden (see its AppDelegate.swift). It serves on the
        // default port until the extension asks again, when the app is running and gets the port as a notification.
        configuration.hides = true
        // The request is answered on a queue of its own, so it can wait for the app.
        let semaphore = DispatchSemaphore(value: 0)
        var launchError: Error?
        NSWorkspace.shared.openApplication(at: appUrl, configuration: configuration) { _, error in
            launchError = error
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + 10) == .timedOut {
            return ["error": "The app did not start in time"]
        }
        if let launchError {
            return ["error": launchError.localizedDescription]
        }
        return ["started": true]
    }
    #endif

    /// The image in the clipboard as a PNG data URL.
    private static func clipboardImage() -> String? {
        lock.lock()
        defer { lock.unlock() }
        #if os(macOS)
        let pasteboard = NSPasteboard.general
        let changeCount = pasteboard.changeCount
        if let image, image.changeCount == changeCount { return image.value }
        var data = pasteboard.data(forType: .png)
        if data == nil, let tiff = pasteboard.data(forType: .tiff) {
            data = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        }
        #else
        let pasteboard = UIPasteboard.general
        let changeCount = pasteboard.changeCount
        if let image, image.changeCount == changeCount { return image.value }
        let data = pasteboard.hasImages ? pasteboard.image?.pngData() : nil
        #endif
        let value = data.map { "data:image/png;base64," + $0.base64EncodedString() }
        image = (changeCount, value)
        return value
    }
}
