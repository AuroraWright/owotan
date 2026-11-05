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

// Builds the Safari variant, wraps it in the app Safari needs to load an extension, and builds the app.
// Needs macOS with Xcode. Writes builds/yomitan-safari-app, which holds the Xcode project and the build.
//
// Without --team the app is signed to run locally, or for the iOS Simulator not signed. On a Mac, Safari then
// loads the extension only while Develop > Developer Settings > Allow unsigned extensions is on; in the
// Simulator it is turned on in Settings > Apps > Safari > Extensions. A device running iOS needs a development
// team, as does distributing the app.
//
// With --team, Xcode signs the app for development with a certificate of that team, and creates or downloads
// the provisioning profiles it needs.
//
// --ipa archives the app for iOS and exports it as builds/yomitan-safari-app/ipa/Yomitan.ipa, to install on
// devices. --identity picks the type of certificate that exporting signs it with: "Apple Development" (the
// default), or "Apple Distribution" for ad hoc distribution. Xcode picks the newest certificate of the type.
// Either way it installs only on the devices that the team has registered.
//
// node dev/bin/build-safari-app.js [--platform macos|ios-simulator|ios] [--team <id>] [--ipa [--identity <type>]]
//     [--bundle-id <id>] [--project-only]

import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseArgs} from 'util';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.join(dirname, '..', '..');
const buildsDirectory = path.join(rootDirectory, 'builds');
const extensionDirectory = path.join(buildsDirectory, 'yomitan-safari');
const appDirectory = path.join(buildsDirectory, 'yomitan-safari-app');
const appName = 'Yomitan';

/** @type {Record<string, {scheme: string, destination: string, products: string}>} */
const platforms = {
    'macos': {scheme: `${appName} (macOS)`, destination: 'generic/platform=macOS', products: 'Release'},
    'ios-simulator': {scheme: `${appName} (iOS)`, destination: 'generic/platform=iOS Simulator', products: 'Release-iphonesimulator'},
    'ios': {scheme: `${appName} (iOS)`, destination: 'generic/platform=iOS', products: 'Release-iphoneos'},
};

/**
 * How an IPA is exported for each type of certificate it can be signed with. Xcode signs an app it builds for
 * development, and exporting signs it again with the type that the method uses.
 * @type {Record<string, string>}
 */
const ipaExportMethods = {
    'Apple Development': 'debugging',
    'Apple Distribution': 'release-testing',
};

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
    execFileSync(command, args, {cwd: rootDirectory, stdio: 'inherit'});
}

const {values: args} = parseArgs({
    args: process.argv.slice(2),
    options: {
        'platform': {type: 'string', default: 'macos'},
        'team': {type: 'string'},
        'identity': {type: 'string'},
        'ipa': {type: 'boolean', default: false},
        'bundle-id': {type: 'string', default: 'org.yomitan.dev'},
        'project-only': {type: 'boolean', default: false},
    },
});
const platform = platforms[args.platform];
if (typeof platform === 'undefined') {
    throw new Error(`Unknown platform ${args.platform}; use one of ${Object.keys(platforms).join(', ')}`);
}
const team = args.team;
if (args.platform === 'ios' && typeof team !== 'string' && !args['project-only']) {
    throw new Error('A device running iOS only installs apps signed by a development team; pass --team');
}
if (args.ipa && args.platform !== 'ios') {
    throw new Error('--ipa is for --platform ios');
}
if (typeof args.identity === 'string' && !args.ipa) {
    throw new Error('--identity picks the certificate that an IPA is signed with; pass --ipa');
}
const identity = args.identity ?? 'Apple Development';
const ipaExportMethod = ipaExportMethods[identity];
if (typeof ipaExportMethod === 'undefined') {
    throw new Error(`An IPA is signed with one of ${Object.keys(ipaExportMethods).join(', ')}`);
}

run('node', [path.join(dirname, 'build.js'), '--target', 'safari']);
// The project gets its own copy of the extension, so that rebuilding the extension does not change it.
run('xcrun', ['safari-web-extension-converter', '--project-location', appDirectory, '--app-name', appName, '--bundle-identifier', args['bundle-id'], '--swift', '--copy-resources', '--no-open', '--no-prompt', '--force', extensionDirectory]);
// The extension reads the clipboard through native messaging, which this handler answers.
fs.copyFileSync(path.join(rootDirectory, 'dev', 'safari', 'SafariWebExtensionHandler.swift'), path.join(appDirectory, appName, 'Shared (Extension)', 'SafariWebExtensionHandler.swift'));
// The macOS app serves the Yomitan API (AppDelegate.swift), for which its sandbox has to let it accept connections.
fs.copyFileSync(path.join(rootDirectory, 'dev', 'safari', 'AppDelegate.swift'), path.join(appDirectory, appName, 'macOS (App)', 'AppDelegate.swift'));
const projectFilePath = path.join(appDirectory, appName, `${appName}.xcodeproj`, 'project.pbxproj');
const macAppSettingsPattern = /(buildSettings = \{[^}]*?)(INFOPLIST_FILE = "macOS \(App\)\/Info\.plist";)/g;
const projectFile = fs.readFileSync(projectFilePath, {encoding: 'utf8'});
if ([...projectFile.matchAll(macAppSettingsPattern)].length === 0) {
    throw new Error('The macOS app target was not found in the Xcode project');
}
fs.writeFileSync(projectFilePath, projectFile.replace(macAppSettingsPattern, '$1ENABLE_INCOMING_NETWORK_CONNECTIONS = YES;\n\t\t\t\t$2'));
if (args['project-only']) {
    process.exit(0);
}

// The project signs automatically, which picks the team of whichever account Xcode has, so it is told how
// to sign either way. A simulator build that Xcode signs still gets that team in its entitlements; unsigned,
// the linker's signature is enough to run it, and Safari lists it as unsigned.
/** @type {string[]} */
let signing;
if (typeof team === 'string') {
    signing = ['-allowProvisioningUpdates', 'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${team}`];
} else if (args.platform === 'ios-simulator') {
    signing = ['CODE_SIGNING_ALLOWED=NO'];
} else {
    signing = ['CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=', 'PROVISIONING_PROFILE_SPECIFIER='];
}
const projectPath = path.join(appDirectory, appName, `${appName}.xcodeproj`);
const derivedDataPath = path.join(appDirectory, 'DerivedData');
const buildArgs = ['-project', projectPath, '-scheme', platform.scheme, '-configuration', 'Release', '-destination', platform.destination, '-derivedDataPath', derivedDataPath, ...signing];
if (!args.ipa) {
    run('xcodebuild', [...buildArgs, 'build']);
    console.log(`Built ${path.join(derivedDataPath, 'Build', 'Products', platform.products, `${appName}.app`)}`);
    process.exit(0);
}

const archivePath = path.join(appDirectory, `${appName}.xcarchive`);
const exportPath = path.join(appDirectory, 'ipa');
const exportOptionsPath = path.join(appDirectory, 'ExportOptions.plist');
run('xcodebuild', [...buildArgs, '-archivePath', archivePath, 'archive']);
fs.writeFileSync(exportOptionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>${ipaExportMethod}</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>teamID</key>
    <string>${team}</string>
</dict>
</plist>
`);
fs.rmSync(exportPath, {recursive: true, force: true});
run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath, '-exportOptionsPlist', exportOptionsPath, '-allowProvisioningUpdates']);
console.log(`Built ${path.join(exportPath, `${appName}.ipa`)}`);
