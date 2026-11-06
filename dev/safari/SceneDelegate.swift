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

// The iOS app's scene delegate, which also makes android.db, which the user copies to the app's folder in the Files
// app, available to the app extension, which reads audio from it (SafariWebExtensionHandler.swift). It also keeps the
// decks and note types that AnkiMobile gives when it opens the app's link, for the app extension.
// dev/bin/build-safari-app.js puts this file in place of the one Xcode's converter generates.

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        openUrls(connectionOptions.urlContexts)
    }

    func scene(_ scene: UIScene, openURLContexts urlContexts: Set<UIOpenURLContext>) {
        openUrls(urlContexts)
    }

    private func openUrls(_ urlContexts: Set<UIOpenURLContext>) {
        for context in urlContexts where context.url.host == "ankimobile-info" {
            // The window is set up after the scene connects
            DispatchQueue.main.async {
                self.showMessage(AnkiMobileInfoStorage.save())
            }
        }
    }

    private func showMessage(_ message: String) {
        guard let viewController = window?.rootViewController else { return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        viewController.present(alert, animated: true)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        LocalAudioStorage.update()
    }

}

/// Copies android.db from the app's folder in the Files app, which the app extension cannot read, to the storage that
/// the app shares with the app extension. The copy is a clone, which takes no more space until either file changes.
enum LocalAudioStorage {
    private static let fileName = "android.db"
    private static let queue = DispatchQueue(label: "org.yomitan.local-audio-storage", qos: .utility)

    /// Copies the file again if it changed, and deletes the copy if the user deleted the file.
    static func update() {
        queue.async {
            let fileManager = FileManager.default
            // The group's identifier is the app's, with "group." before it.
            guard
                let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first,
                let bundleIdentifier = Bundle.main.bundleIdentifier,
                let shared = fileManager.containerURL(forSecurityApplicationGroupIdentifier: "group.\(bundleIdentifier)")
            else { return }
            let file = documents.appendingPathComponent(fileName)
            let copy = shared.appendingPathComponent(fileName)

            guard let attributes = try? fileManager.attributesOfItem(atPath: file.path) else {
                try? fileManager.removeItem(at: copy)
                return
            }
            if let copyAttributes = try? fileManager.attributesOfItem(atPath: copy.path),
               copyAttributes[.size] as? Int == attributes[.size] as? Int,
               copyAttributes[.modificationDate] as? Date == attributes[.modificationDate] as? Date {
                return
            }

            // The new copy replaces the old one at once, so that the app extension never reads part of a file.
            let newCopy = shared.appendingPathComponent(".\(fileName).new")
            try? fileManager.removeItem(at: newCopy)
            do {
                try fileManager.copyItem(at: file, to: newCopy)
                try fileManager.setAttributes([.modificationDate: attributes[.modificationDate] ?? Date()], ofItemAtPath: newCopy.path)
                guard rename(newCopy.path, copy.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            } catch {
                try? fileManager.removeItem(at: newCopy)
            }
        }
    }
}

/// Keeps the decks and note types that AnkiMobile puts on the pasteboard for an `infoForAdding` link, before it opens
/// the app's link, where the app extension reads them (SafariWebExtensionHandler.swift).
enum AnkiMobileInfoStorage {
    private static let fileName = "ankimobile-info.json"
    private static let pasteboardType = "net.ankimobile.json"

    /// Returns what to tell the user.
    static func save() -> String {
        // iOS asks the user whether to allow the app to read what another app put on the pasteboard
        guard let data = UIPasteboard.general.data(forPasteboardType: pasteboardType) else {
            return "AnkiMobile did not give its decks and note types."
        }
        guard
            let bundleIdentifier = Bundle.main.bundleIdentifier,
            let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.\(bundleIdentifier)")
        else {
            return "The decks and note types could not be saved."
        }
        do {
            try data.write(to: shared.appendingPathComponent(fileName), options: .atomic)
        } catch {
            return "The decks and note types could not be saved: \(error.localizedDescription)"
        }
        return "Yomitan has the decks and note types from AnkiMobile. You can go back to Safari."
    }
}
