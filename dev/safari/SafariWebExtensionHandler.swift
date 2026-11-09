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
// clipboard, so on macOS the extension asks the app extension, which can. The app extension also plays audio, which
// Safari does not let a page play without a gesture (AudioPlayer). On macOS it also starts the app, which serves the
// Yomitan API (AppDelegate.swift), when the extension needs it. On iOS it reads audio from android.db, and the decks
// and note types that AnkiMobile gave, which the app keeps where the app extension can read them (SceneDelegate.swift).
// dev/bin/build-safari-app.js puts this file in place of the one Xcode's converter generates.

import AVFoundation
import SafariServices
#if os(macOS)
import AppKit
#else
import SQLite3
#endif

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    #if os(macOS)
    // The clipboard monitor reads the clipboard several times a second, so what was read is kept until the
    // clipboard changes.
    private static let lock = NSLock()
    private static var text: (changeCount: Int, value: String)?
    private static var image: (changeCount: Int, value: String?)?
    #endif

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
        let respond = { (response: [String: Any]) in
            let item = NSExtensionItem()
            item.userInfo = [Self.messageKey: response]
            context.completeRequest(returningItems: [item], completionHandler: nil)
        }

        let response: [String: Any]
        switch message?["action"] as? String {
        #if os(macOS)
        case "getClipboardText":
            response = ["text": Self.clipboardText()]
        case "getClipboardImage":
            response = ["image": Self.clipboardImage() ?? NSNull()]
        #else
        // iOS lets only the app in front read the clipboard, which the app extension never is, so it is always empty.
        case "getClipboardText":
            response = ["text": ""]
        case "getClipboardImage":
            response = ["image": NSNull()]
        #endif
        case "playAudio":
            // Answered once the audio has stopped, as iOS suspends the app extension once it has answered.
            AudioPlayer.play(id: message?["id"] as? String ?? "", data: message?["data"] as? String ?? "", volume: message?["volume"] as? Double ?? 1, completion: respond)
            return
        case "stopAudio":
            AudioPlayer.stop(id: message?["id"] as? String ?? "")
            response = [:]
        #if os(macOS)
        case "startApiServer":
            response = Self.startApiServer(port: message?["port"] as? Int ?? 19633)
        #else
        case "getLocalAudioEntries":
            response = LocalAudioDatabase.entries(term: message?["term"] as? String ?? "", reading: message?["reading"] as? String ?? "")
        case "getLocalAudio":
            response = LocalAudioDatabase.audio(source: message?["source"] as? String ?? "", file: message?["file"] as? String ?? "")
        case "getAnkiMobileInfo":
            response = AnkiMobileInfo.read()
        case "getAnkiMobileInfoCallbackUrl":
            response = AnkiMobileInfo.callbackUrl()
        #endif
        default:
            response = ["error": "Unsupported message"]
        }

        respond(response)
    }

    #if os(macOS)
    private static func clipboardText() -> String {
        lock.lock()
        defer { lock.unlock() }
        let pasteboard = NSPasteboard.general
        let changeCount = pasteboard.changeCount
        if let text, text.changeCount == changeCount { return text.value }
        let value = pasteboard.string(forType: .string) ?? ""
        text = (changeCount, value)
        return value
    }

    /// Starts the app that holds this extension, without a window, to serve the Yomitan API on the port, or has
    /// the running app serve on it.
    private static func startApiServer(port: Int) -> [String: Any] {
        // The app extension is at OwOtan.app/Contents/PlugIns/<name>.appex
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
            DistributedNotificationCenter.default().postNotificationName(Notification.Name("org.owotan.api.port"), object: String(port), userInfo: nil, deliverImmediately: true)
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

    /// The image in the clipboard as a PNG data URL.
    private static func clipboardImage() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let pasteboard = NSPasteboard.general
        let changeCount = pasteboard.changeCount
        if let image, image.changeCount == changeCount { return image.value }
        var data = pasteboard.data(forType: .png)
        if data == nil, let tiff = pasteboard.data(forType: .tiff) {
            data = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        }
        let value = data.map { "data:image/png;base64," + $0.base64EncodedString() }
        image = (changeCount, value)
        return value
    }
    #endif
}

/// Plays audio for the extension. Safari plays audio in a page only after a gesture in it has started audio, which a
/// popup never gets when it opens on hover or for the first lookup on a page, while the app extension can play audio
/// whenever it is asked to.
/// The message to play audio is answered once the audio has stopped, as iOS suspends the app extension once it has
/// answered every message; the extension stops it with a message of its own. One audio plays at a time.
final class AudioPlayer: NSObject, AVAudioPlayerDelegate {
    private static let lock = NSLock()
    /// The audio that plays, with the identifier the extension gave it and the answer to the message that plays it.
    private static var current: (player: AVAudioPlayer, id: String, completion: ([String: Any]) -> Void)?
    private static let delegate = AudioPlayer()

    /// Plays audio encoded with base64, in place of the audio that plays, and calls the completion once it stops.
    static func play(id: String, data: String, volume: Double, completion: @escaping ([String: Any]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        finish(["stopped": true], deactivating: false)
        guard let bytes = Data(base64Encoded: data) else {
            completion(["error": "The audio is not base64"])
            return
        }
        do {
            #if os(iOS)
            // Audio playing in other apps, such as music, is lowered while this plays. Only an app extension with the
            // background mode for audio can play it (dev/bin/build-safari-app.js), as iOS runs it in the background.
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            #endif
            let player = try AVAudioPlayer(data: bytes)
            player.delegate = delegate
            player.volume = Float(max(0, min(1, volume)))
            guard player.play() else {
                deactivate()
                completion(["error": "The audio could not be played"])
                return
            }
            current = (player, id, completion)
            // In case the player never reports the end of the audio, which would keep the message from being answered.
            DispatchQueue.main.asyncAfter(deadline: .now() + player.duration + 5) {
                lock.lock()
                defer { lock.unlock() }
                if current?.player === player {
                    finish(["finished": true], deactivating: true)
                }
            }
        } catch {
            deactivate()
            completion(["error": error.localizedDescription])
        }
    }

    /// Stops the audio with the identifier, if it still plays.
    static func stop(id: String) {
        lock.lock()
        defer { lock.unlock() }
        if current?.id == id {
            finish(["stopped": true], deactivating: true)
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        if Self.current?.player === player {
            Self.finish(["finished": true], deactivating: true)
        }
    }

    /// Stops the audio that plays and answers the message that played it. Called with the lock held.
    private static func finish(_ response: [String: Any], deactivating: Bool) {
        guard let current else { return }
        self.current = nil
        current.player.stop()
        if deactivating {
            deactivate()
        }
        current.completion(response)
    }

    /// Lets audio playing in other apps return to its volume.
    private static func deactivate() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        #endif
    }
}

#if os(iOS)
/// The storage that the app shares with this app extension.
enum SharedStorage {
    /// This app extension's identifier is the app's followed by its own name.
    static func appIdentifier() -> String? {
        guard let extensionIdentifier = Bundle.main.bundleIdentifier, let dot = extensionIdentifier.lastIndex(of: ".") else { return nil }
        return String(extensionIdentifier[..<dot])
    }

    /// The group's identifier is the app's, with "group." before it.
    static func directory() -> URL? {
        guard let appIdentifier = appIdentifier() else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.\(appIdentifier)")
    }
}

/// The decks and note types that AnkiMobile gives for an `infoForAdding` link. AnkiMobile puts them on the
/// pasteboard and opens the link's `x-success`, which is the app's (SceneDelegate.swift), as only the app in front
/// can read the pasteboard. The app keeps them in the storage that it shares with this app extension.
enum AnkiMobileInfo {
    static let fileName = "ankimobile-info.json"

    /// AnkiMobile's JSON, as it gave it.
    static func read() -> [String: Any] {
        guard let url = SharedStorage.directory()?.appendingPathComponent(fileName) else {
            return ["error": "The storage shared with the app was not found"]
        }
        guard let data = try? Data(contentsOf: url), let info = String(data: data, encoding: .utf8) else {
            return ["info": NSNull()]
        }
        return ["info": info]
    }

    /// The app's URL scheme is its identifier (build-safari-app.js).
    static func callbackUrl() -> [String: Any] {
        guard let appIdentifier = SharedStorage.appIdentifier() else {
            return ["error": "The app was not found"]
        }
        return ["callbackUrl": "\(appIdentifier)://ankimobile-info"]
    }
}

/// Reads android.db, which the Local Audio Server for Yomichan add-on for Anki creates. It holds the add-on's table
/// of entries, and the audio files in a table named android. The app keeps a copy of the one that the user puts in
/// its folder in the Files app in the storage that it shares with this app extension (SceneDelegate.swift).
enum LocalAudioDatabase {
    static let fileName = "android.db"

    private static let lock = NSLock()
    /// The open database, with the file it was opened from, which the app replaces rather than changes.
    private static var connection: (fileNumber: Int, database: OpaquePointer)?

    /// The entries whose expression is the term or whose reading is the reading, if there is one.
    static func entries(term: String, reading: String) -> [String: Any] {
        query("SELECT expression, reading, source, display, file FROM entries WHERE expression = ?1 OR (?2 <> '' AND reading = ?2)", [term, reading]) { statement in
            var entries: [[String: Any]] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                entries.append([
                    "expression": text(statement, 0) ?? "",
                    "reading": text(statement, 1) ?? NSNull(),
                    "source": text(statement, 2) ?? "",
                    "display": text(statement, 3) ?? NSNull(),
                    "file": text(statement, 4) ?? "",
                ])
            }
            return ["entries": entries]
        }
    }

    /// The audio file of a source, encoded with base64.
    static func audio(source: String, file: String) -> [String: Any] {
        query("SELECT data FROM android WHERE file = ?1 AND source = ?2", [file, source]) { statement in
            guard sqlite3_step(statement) == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else {
                return ["error": "The audio was not found in \(fileName)"]
            }
            let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
            return ["data": data.base64EncodedString()]
        }
    }

    private static func query(_ sql: String, _ parameters: [String], _ read: (OpaquePointer) -> [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let database = open() else {
            return ["error": "\(fileName) was not found. Copy it to On My iPhone › OwOtan in the Files app, then open the OwOtan app."]
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            return ["error": String(cString: sqlite3_errmsg(database))]
        }
        defer { sqlite3_finalize(statement) }
        // SQLITE_TRANSIENT, which Swift does not import: SQLite copies the text.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, parameter) in parameters.enumerated() {
            sqlite3_bind_text(statement, Int32(index + 1), parameter, -1, transient)
        }
        return read(statement)
    }

    /// Opens the database, again once the app has replaced it.
    private static func open() -> OpaquePointer? {
        guard let url = SharedStorage.directory()?.appendingPathComponent(fileName),
              let fileNumber = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.systemFileNumber] as? Int else {
            close()
            return nil
        }
        if let connection, connection.fileNumber == fileNumber {
            return connection.database
        }
        close()
        // Immutable, as the app replaces the file instead of writing to it, so SQLite neither locks nor journals it.
        var database: OpaquePointer?
        guard sqlite3_open_v2("\(url.absoluteString)?immutable=1", &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let database else {
            sqlite3_close(database)
            return nil
        }
        connection = (fileNumber, database)
        return database
    }

    private static func close() {
        if let connection {
            sqlite3_close(connection.database)
        }
        connection = nil
    }

    private static func text(_ statement: OpaquePointer, _ column: Int32) -> String? {
        sqlite3_column_text(statement, column).map { String(cString: $0) }
    }
}
#endif
