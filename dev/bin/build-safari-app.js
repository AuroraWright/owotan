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
// --ipa archives the app for iOS and exports it as builds/yomitan-safari-app/ipa/OwOtan.ipa, to install on
// devices. --identity picks the type of certificate that exporting signs it with: "Apple Development" (the
// default), or "Apple Distribution" for ad hoc distribution. Xcode picks the newest certificate of the type.
// Either way it installs only on the devices that the team has registered.
//
// --app-store archives the app for iOS and exports it for App Store Connect, signed with an Apple Distribution
// certificate, as builds/yomitan-safari-app/ipa/OwOtan.ipa. The App Store does not allow the app extension to play
// audio, so audio plays in the page, where Safari needs a gesture before it plays. With --upload, exporting uploads
// it to App Store Connect instead, through the account signed in to Xcode, where it can be tested with TestFlight.
// App Store Connect needs each upload to have a higher build number, so --app-store needs --version or --build.
//
// --developer-id archives the app for macOS and exports it signed with a Developer ID Application certificate, to
// share outside the Mac App Store; Safari 18.4 and later load its extension. Apple then notarizes it, with the
// credentials that `xcrun notarytool store-credentials` saved under the name given with --keychain-profile, and the
// app is stapled and zipped as builds/yomitan-safari-app/developer-id/OwOtan.zip.
//
// --version sets the version of the app, and --build its build number, which is the version unless given. Each is up
// to three numbers separated by periods, such as 20261109 and 20261109.1. The build number is also the version of the
// extension, as `npm run build -- --version` sets it.
//
// node dev/bin/build-safari-app.js [--platform macos|ios-simulator|ios] [--team <id>] [--version <version>]
//     [--build <build number>]
//     [--ipa [--identity <type>] | --app-store [--upload] | --developer-id --keychain-profile <name>]
//     [--bundle-id <id>] [--project-only]

import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseArgs} from 'util';
import {parseJson} from '../json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.join(dirname, '..', '..');
const buildsDirectory = path.join(rootDirectory, 'builds');
const extensionDirectory = path.join(buildsDirectory, 'yomitan-safari');
const appDirectory = path.join(buildsDirectory, 'yomitan-safari-app');
const appName = 'OwOtan';

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
 * @param {Record<string, string | undefined>} [env]
 */
function run(command, args, env = process.env) {
    execFileSync(command, args, {cwd: rootDirectory, stdio: 'inherit', env});
}

/**
 * Removes the LaunchServices records of copies of the app, also of copies that no longer exist.
 * @param {string[]} appPaths
 */
function unregisterApps(appPaths) {
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    for (const appPath of appPaths) {
        try {
            execFileSync(lsregister, ['-u', appPath], {stdio: 'ignore'});
        } catch (e) {
            // It wasn't registered
        }
    }
}

const {values: args} = parseArgs({
    args: process.argv.slice(2),
    options: {
        'platform': {type: 'string', default: 'macos'},
        'team': {type: 'string'},
        'identity': {type: 'string'},
        'ipa': {type: 'boolean', default: false},
        'app-store': {type: 'boolean', default: false},
        'upload': {type: 'boolean', default: false},
        'developer-id': {type: 'boolean', default: false},
        'keychain-profile': {type: 'string'},
        'version': {type: 'string'},
        'build': {type: 'string'},
        'bundle-id': {type: 'string', default: 'org.owotan.dev'},
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
const version = args.version;
const buildNumber = args.build ?? version;
for (const [name, value] of [['version', version], ['build number', buildNumber]]) {
    if (typeof value === 'string' && !/^\d+(\.\d+){0,2}$/.test(value)) {
        throw new Error(`The ${name} ${value} is not up to three numbers separated by periods`);
    }
}
if (args['app-store']) {
    if (args.platform !== 'ios' || typeof team !== 'string') {
        throw new Error('--app-store is for --platform ios with --team');
    }
    if (args.ipa) {
        throw new Error('--app-store exports its own IPA; pass either --ipa or --app-store');
    }
    if (typeof buildNumber !== 'string') {
        throw new Error('App Store Connect needs a higher build number for each upload; pass --version or --build');
    }
}
if (args['developer-id']) {
    if (args.platform !== 'macos' || typeof team !== 'string') {
        throw new Error('--developer-id is for --platform macos with --team');
    }
    if (typeof args['keychain-profile'] !== 'string') {
        throw new Error('Apple notarizes the app with the credentials that notarytool saved; pass --keychain-profile');
    }
}
if (typeof args['keychain-profile'] === 'string' && !args['developer-id']) {
    throw new Error('--keychain-profile is for notarizing; pass --developer-id');
}
if (args.upload && !args['app-store']) {
    throw new Error('--upload sends a build for App Store Connect; pass --app-store');
}

run('node', [path.join(dirname, 'build.js'), '--target', 'safari', ...(typeof buildNumber === 'string' ? ['--version', buildNumber] : [])]);
// The project gets its own copy of the extension, so that rebuilding the extension does not change it.
run('xcrun', ['safari-web-extension-converter', '--project-location', appDirectory, '--app-name', appName, '--bundle-identifier', args['bundle-id'], '--swift', '--copy-resources', '--no-open', '--no-prompt', '--force', extensionDirectory]);
// Xcode 27 and later write the project as project.xcproj, which the edits below do not read, so it is converted to
// project.pbxproj.
const xcodeProjectPath = path.join(appDirectory, appName, `${appName}.xcodeproj`);
if (fs.existsSync(path.join(xcodeProjectPath, 'project.xcproj'))) {
    run('xcodebuild', ['-project', xcodeProjectPath, '-convert-project', 'pbxproj']);
}
// The extension sends native messages to the app extension, which this handler answers.
fs.copyFileSync(path.join(rootDirectory, 'dev', 'safari', 'SafariWebExtensionHandler.swift'), path.join(appDirectory, appName, 'Shared (Extension)', 'SafariWebExtensionHandler.swift'));
// The macOS app serves the Yomitan API (AppDelegate.swift), for which its sandbox has to let it accept connections.
fs.copyFileSync(path.join(rootDirectory, 'dev', 'safari', 'AppDelegate.swift'), path.join(appDirectory, appName, 'macOS (App)', 'AppDelegate.swift'));
// The iOS app copies android.db, which the user puts in its folder in the Files app, to storage that it shares with
// the app extension, which reads audio from it (SceneDelegate.swift).
fs.copyFileSync(path.join(rootDirectory, 'dev', 'safari', 'SceneDelegate.swift'), path.join(appDirectory, appName, 'iOS (App)', 'SceneDelegate.swift'));
// The App Store requires apps to give their reasons for the APIs that Apple lists, such as SceneDelegate.swift's use of
// file modification dates.
fs.copyFileSync(path.join(rootDirectory, 'dev', 'safari', 'PrivacyInfo.xcprivacy'), path.join(appDirectory, appName, 'iOS (App)', 'PrivacyInfo.xcprivacy'));
const iosAppInfoPath = path.join(appDirectory, appName, 'iOS (App)', 'Info.plist');
for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) {
    run('plutil', ['-replace', key, '-bool', 'YES', iosAppInfoPath]);
}
// The app uses no encryption other than the system's, such as HTTPS, which export regulations exempt. Saying so
// here saves answering for each build that App Store Connect receives.
run('plutil', ['-replace', 'ITSAppUsesNonExemptEncryption', '-bool', 'NO', iosAppInfoPath]);
// AnkiMobile gives its decks and note types to an app, by opening the app's link (SceneDelegate.swift). The link's
// scheme is the app's identifier, so that builds with other identifiers do not take each other's links.
run('plutil', ['-replace', 'CFBundleURLTypes', '-json', '[{"CFBundleURLName": "$(PRODUCT_BUNDLE_IDENTIFIER)", "CFBundleURLSchemes": ["$(PRODUCT_BUNDLE_IDENTIFIER)"]}]', iosAppInfoPath]);
if (args['app-store']) {
    // The App Store does not allow an app extension to have a background mode, so the extension plays audio in the
    // page instead of through the app extension (ext/js/media/safari-audio.js).
    const safariAudioPath = path.join(appDirectory, appName, 'Shared (Extension)', 'Resources', 'js', 'media', 'safari-audio.js');
    const safariAudio = fs.readFileSync(safariAudioPath, {encoding: 'utf8'});
    const nativeAudioSetting = 'export const safariNativeAudio = true;';
    if (!safariAudio.includes(nativeAudioSetting)) {
        throw new Error(`${safariAudioPath} does not contain ${nativeAudioSetting}`);
    }
    fs.writeFileSync(safariAudioPath, safariAudio.replace(nativeAudioSetting, 'export const safariNativeAudio = false;'));
} else {
    // The app extension plays audio for the extension (SafariWebExtensionHandler.swift). iOS runs it in the background,
    // where only a process with the background mode for audio can start audio.
    run('plutil', ['-replace', 'UIBackgroundModes', '-json', '["audio"]', path.join(appDirectory, appName, 'iOS (Extension)', 'Info.plist')]);
}
const iosEntitlementsName = `${appName} (iOS).entitlements`;
fs.writeFileSync(path.join(appDirectory, appName, iosEntitlementsName), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>group.${args['bundle-id']}</string>
    </array>
</dict>
</plist>
`);

const projectFilePath = path.join(appDirectory, appName, `${appName}.xcodeproj`, 'project.pbxproj');
let projectFile = fs.readFileSync(projectFilePath, {encoding: 'utf8'});
/**
 * Adds a build setting to the configurations of the target whose Info.plist is at a path.
 * @param {string} infoPlistPath
 * @param {string} setting
 * @throws {Error} If the project has no such target.
 */
function addBuildSetting(infoPlistPath, setting) {
    const pattern = new RegExp(`(buildSettings = \\{[^}]*?)(INFOPLIST_FILE = "${infoPlistPath.replace(/[()./]/g, '\\$&')}";)`, 'g');
    if ([...projectFile.matchAll(pattern)].length === 0) {
        throw new Error(`The target of ${infoPlistPath} was not found in the Xcode project`);
    }
    projectFile = projectFile.replace(pattern, `$1${setting}\n\t\t\t\t$2`);
}
/**
 * Adds a file in a group's folder to the resources of a target.
 * @param {string} groupName
 * @param {string} targetName
 * @param {string} fileName
 * @throws {Error} If the project has no such group or target.
 */
function addResource(groupName, targetName, fileName) {
    const escape = (/** @type {string} */ value) => value.replace(/[()./]/g, '\\$&');
    const groupChildren = new RegExp(`\\w+ /\\* ${escape(groupName)} \\*/ = \\{\\s*isa = PBXGroup;\\s*children = \\(\\n`).exec(projectFile);
    const target = new RegExp(`/\\* ${escape(targetName)} \\*/ = \\{\\s*isa = PBXNativeTarget;[^}]*?buildPhases = \\(([^)]*)\\);`).exec(projectFile);
    const resourcesPhaseId = target !== null ? /(\w+) \/\* Resources \*\//.exec(target[1]) : null;
    const resourcesFiles = resourcesPhaseId !== null ? new RegExp(`${resourcesPhaseId[1]} /\\* Resources \\*/ = \\{\\s*isa = PBXResourcesBuildPhase;[^(]*files = \\(\\n`).exec(projectFile) : null;
    if (groupChildren === null || resourcesFiles === null) {
        throw new Error(`The group ${groupName} or the resources of the target ${targetName} were not found in the Xcode project`);
    }
    // Object IDs are 24 hexadecimal digits, made here from the file and target names so that they stay the same
    /** @type {(kind: string) => string} */
    const createId = (kind) => createHash('sha256')
        .update(`${targetName}/${fileName}/${kind}`)
        .digest('hex')
        .slice(0, 24)
        .toUpperCase();
    const fileId = createId('file');
    const buildFileId = createId('build');
    projectFile = projectFile
        .replace('/* Begin PBXBuildFile section */\n', `$&\t\t${buildFileId} /* ${fileName} in Resources */ = {isa = PBXBuildFile; fileRef = ${fileId} /* ${fileName} */; };\n`)
        .replace('/* Begin PBXFileReference section */\n', `$&\t\t${fileId} /* ${fileName} */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = ${fileName}; sourceTree = "<group>"; };\n`)
        .replace(groupChildren[0], `${groupChildren[0]}\t\t\t\t${fileId} /* ${fileName} */,\n`)
        .replace(resourcesFiles[0], `${resourcesFiles[0]}\t\t\t\t${buildFileId} /* ${fileName} in Resources */,\n`);
}
addResource('iOS (App)', `${appName} (iOS)`, 'PrivacyInfo.xcprivacy');
addBuildSetting('macOS (App)/Info.plist', 'ENABLE_INCOMING_NETWORK_CONNECTIONS = YES;');
addBuildSetting('iOS (App)/Info.plist', `CODE_SIGN_ENTITLEMENTS = "${iosEntitlementsName}";`);
addBuildSetting('iOS (Extension)/Info.plist', `CODE_SIGN_ENTITLEMENTS = "${iosEntitlementsName}";`);
const iosDeploymentTargetPattern = /IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g;
if ([...projectFile.matchAll(iosDeploymentTargetPattern)].length === 0) {
    throw new Error('The Xcode project sets no iOS deployment target');
}
projectFile = projectFile.replace(iosDeploymentTargetPattern, 'IPHONEOS_DEPLOYMENT_TARGET = 18.0;');
for (const [setting, value] of [['MARKETING_VERSION', version], ['CURRENT_PROJECT_VERSION', buildNumber]]) {
    if (typeof value !== 'string') { continue; }
    const pattern = new RegExp(`${setting} = [^;]*;`, 'g');
    if ([...projectFile.matchAll(pattern)].length === 0) {
        throw new Error(`The Xcode project sets no ${setting}`);
    }
    projectFile = projectFile.replace(pattern, `${setting} = ${value};`);
}
// Automatic signing registers the group, and adds it to the profiles, only for the targets that have it as a capability.
for (const targetName of [`${appName} (iOS)`, `${appName} Extension (iOS)`]) {
    const target = new RegExp(`(\\w+) /\\* ${targetName.replace(/[()]/g, '\\$&')} \\*/ = \\{\\s*isa = PBXNativeTarget;`).exec(projectFile);
    // A project that Xcode 27 converted from project.xcproj has no attributes for its targets, so they are added.
    if (target !== null && !new RegExp(`\\t+${target[1]} = \\{\\n`).test(projectFile)) {
        const projectAttributes = /(\t+)isa = PBXProject;\n\t+attributes = \{\n/.exec(projectFile);
        if (projectAttributes === null) {
            throw new Error('The attributes of the project were not found in the Xcode project');
        }
        const indent = `${projectAttributes[1]}\t`;
        if (!projectFile.includes('TargetAttributes = {\n')) {
            projectFile = projectFile.replace(projectAttributes[0], `${projectAttributes[0]}${indent}TargetAttributes = {\n${indent}};\n`);
        }
        projectFile = projectFile.replace(/(\t+)TargetAttributes = \{\n/, (match, tabs) => `${match}${tabs}\t${target[1]} = {\n${tabs}\t};\n`);
    }
    const attributes = target !== null ? new RegExp(`(\\t+)${target[1]} = \\{\\n`).exec(projectFile) : null;
    if (target === null || attributes === null) {
        throw new Error(`The target ${targetName} was not found in the Xcode project`);
    }
    const indent = `${attributes[1]}\t`;
    projectFile = projectFile.replace(attributes[0], `${attributes[0]}${indent}SystemCapabilities = {\n${indent}\tcom.apple.ApplicationGroups.iOS = {\n${indent}\t\tenabled = 1;\n${indent}\t};\n${indent}};\n`);
}
fs.writeFileSync(projectFilePath, projectFile);
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
// Spotlight skips folders named .noindex. A copy of the app that it finds can be registered with LaunchServices, as
// when another app looks the app up, and registering or unregistering a copy removes the extension from Safari, which
// adds it again at a new address.
const derivedDataPath = path.join(appDirectory, 'DerivedData.noindex');
const buildArgs = ['-project', projectPath, '-scheme', platform.scheme, '-configuration', 'Release', '-destination', platform.destination, '-derivedDataPath', derivedDataPath, ...signing];
if (!args.ipa && !args['app-store'] && !args['developer-id']) {
    run('xcodebuild', [...buildArgs, 'build']);
    console.log(`Built ${path.join(derivedDataPath, 'Build', 'Products', platform.products, `${appName}.app`)}`);
    process.exit(0);
}

const archivePath = path.join(appDirectory, `${appName}.xcarchive`);
const exportPath = path.join(appDirectory, args['developer-id'] ? 'developer-id' : 'ipa');
const exportOptionsPath = path.join(appDirectory, 'ExportOptions.plist');
run('xcodebuild', [...buildArgs, '-archivePath', archivePath, 'archive']);
// For App Store Connect, exporting would otherwise give the build a number of its own instead of --build
const appStoreOptions = args['app-store'] ?
    `
    <key>manageAppVersionAndBuildNumber</key>
    <false/>
    <key>destination</key>
    <string>${args.upload ? 'upload' : 'export'}</string>` :
    '';
fs.writeFileSync(exportOptionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>${args['app-store'] ? 'app-store-connect' : (args['developer-id'] ? 'developer-id' : ipaExportMethod)}</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>teamID</key>
    <string>${team}</string>${appStoreOptions}
</dict>
</plist>
`);
fs.rmSync(exportPath, {recursive: true, force: true});
// Exporting copies the app with /usr/bin/rsync, which starts the rsync it finds first on the PATH for the other end
// of the copy, and fails if that is another version of rsync, such as Homebrew's
const exportEnv = {...process.env, PATH: `/usr/bin:${process.env.PATH ?? ''}`};
run('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath, '-exportOptionsPlist', exportOptionsPath, '-allowProvisioningUpdates'], exportEnv);
if (args['developer-id']) {
    const appPath = path.join(exportPath, `${appName}.app`);
    const zipPath = path.join(exportPath, `${appName}.zip`);
    // Apple notarizes a zip of the app, and the ticket is then stapled to the app itself, so that Gatekeeper accepts
    // it without asking Apple. The zip that is shared holds the stapled app.
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
    const keychainProfile = /** @type {string} */ (args['keychain-profile']);
    const submission = /** @type {{id: string, status: string}} */ (parseJson(execFileSync('xcrun', ['notarytool', 'submit', zipPath, '--keychain-profile', keychainProfile, '--wait', '--output-format', 'json'], {cwd: rootDirectory, encoding: 'utf8'})));
    if (submission.status !== 'Accepted') {
        run('xcrun', ['notarytool', 'log', submission.id, '--keychain-profile', keychainProfile]);
        throw new Error(`Apple did not notarize the app: ${submission.status}`);
    }
    run('xcrun', ['stapler', 'staple', appPath]);
    fs.rmSync(zipPath);
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
    // LaunchServices registers the copies of the app that archiving and exporting make, and keeps the record of a
    // copy after it is deleted, as the one that archiving installs in DerivedData is. Safari then finds no app for the
    // extension when it launches, takes the extension to have been removed, and adds it again turned off, at a new
    // address that has none of its data. So only the copy that the user installs stays registered, and the exported
    // copy, which the zip holds, is deleted.
    unregisterApps([
        path.join(derivedDataPath, 'Build', 'Intermediates.noindex', 'ArchiveIntermediates', platform.scheme, 'InstallationBuildProductsLocation', 'Applications', `${appName}.app`),
        path.join(archivePath, 'Products', 'Applications', `${appName}.app`),
        appPath,
    ]);
    fs.rmSync(appPath, {recursive: true});
    console.log(`Built ${zipPath}`);
} else if (args.upload) {
    console.log(`Uploaded ${appName} ${version ?? ''} (${buildNumber}) to App Store Connect`);
} else {
    console.log(`Built ${path.join(exportPath, `${appName}.ipa`)}`);
}
