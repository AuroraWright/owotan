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

// The macOS app's delegate, which also serves the Yomitan API. In other browsers the API is served by a native
// messaging component (yomidevs/yomitan-api), which Safari cannot run, so this app takes its place: it answers
// the same HTTP requests and hands the others to the extension, which polls for them.
// dev/bin/build-safari-app.js puts this file in place of the one Xcode's converter generates.

import Cocoa
import Network

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private let apiServer = YomitanApiServer()
    /// Whether the extension started the app to serve the API, rather than the user opening it.
    private var servesOnly = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Without a Dock icon, nothing shows that the app runs, so it quits when the extension stops asking.
        // Opened by the user, it only stops serving, so as not to keep the port from other programs.
        apiServer.onIdle = { [weak self] in
            guard let self else { return }
            if self.servesOnly {
                NSApp.terminate(nil)
            } else {
                self.apiServer.stop()
            }
        }
        // The app extension starts the app hidden to serve the API, which is all it can ask: macOS drops the arguments
        // and environment that sandboxed processes launch apps with. Opened by the user, the app serves once the
        // app extension asks it to.
        if NSApp.isHidden {
            servesOnly = true
            NSApp.setActivationPolicy(.accessory)
            apiServer.start()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Opened by the user while serving the API, the app shows its window as when it starts.
        if servesOnly {
            servesOnly = false
            NSApp.setActivationPolicy(.regular)
            NSApp.unhide(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return !servesOnly
    }
}

/// Serves the Yomitan API on 127.0.0.1, on port 19633 unless the extension asks for another, as yomitan_api.py does.
final class YomitanApiServer {
    /// The distributed notification with which the app extension asks the running app to serve, with the port as
    /// its object.
    static let portNotificationName = Notification.Name("org.owotan.api.port")
    /// How long to wait before listening again when the port is in use, such as by another browser's native component.
    private static let listenRetryDelay: TimeInterval = 5
    /// The version of the native messaging component that this stands in for.
    private static let version = 1
    /// The prefix of the paths only the extension uses, which no API action starts with.
    private static let extensionPathPrefix = "/__yomitan/"
    /// How long a poll from the extension waits for a request.
    private static let pollTimeout: TimeInterval = 25
    /// How long a request waits for the extension to answer it.
    private static let requestTimeout: TimeInterval = 30
    /// How long after its last poll the extension is taken to be gone.
    private static let extensionTimeout: TimeInterval = 60

    /// Called when the extension has stopped polling.
    var onIdle: (() -> Void)?
    private var port: UInt16 = 19633

    /// The app does nothing else, and its code runs on the main actor by default.
    private let queue = DispatchQueue.main
    private var listener: NWListener?
    /// Requests waiting for the extension to take them, in order.
    private var pendingRequests: [PendingRequest] = []
    /// Requests the extension has taken and not yet answered.
    private var takenRequests: [Int: PendingRequest] = [:]
    /// Polls from the extension waiting for a request.
    private var waitingPolls: [HttpConnection] = []
    private var nextRequestId = 0
    private var lastPoll = Date.distantPast
    /// Checks for the extension having stopped polling, while serving.
    private var idleTimer: DispatchSourceTimer?
    private var portObserver: NSObjectProtocol?

    private final class PendingRequest {
        let id: Int
        let message: [String: Any]
        let connection: HttpConnection

        init(id: Int, message: [String: Any], connection: HttpConnection) {
            self.id = id
            self.message = message
            self.connection = connection
        }
    }

    init() {
        // The app extension asks the app to serve while the extension cannot reach it.
        portObserver = DistributedNotificationCenter.default().addObserver(forName: Self.portNotificationName, object: nil, queue: .main) { [weak self] notification in
            guard let self, let port = (notification.object as? String).flatMap(UInt16.init) else { return }
            if port != self.port || self.idleTimer == nil {
                self.port = port
                self.start()
            }
        }
    }

    /// Serves until `stop`.
    func start() {
        listen()
        lastPoll = Date()
        guard idleTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in self?.checkIdle() }
        timer.resume()
        idleTimer = timer
    }

    func stop() {
        idleTimer?.cancel()
        idleTimer = nil
        listener?.cancel()
        listener = nil
    }

    private func listen() {
        listener?.cancel()
        listener = nil
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port) ?? 19633)
        guard let listener = try? NWListener(using: parameters) else { return }
        let port = self.port
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard case .failed = state, let self, self.listener === listener, self.port == port else { return }
            self.listener = nil
            self.queue.asyncAfter(deadline: .now() + Self.listenRetryDelay) { [weak self] in
                guard let self, self.idleTimer != nil, self.listener == nil, self.port == port else { return }
                self.listen()
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            let httpConnection = HttpConnection(connection: connection, queue: self.queue) { request, httpConnection in
                self.handle(request, on: httpConnection)
            }
            httpConnection.onClose = { [weak self, weak httpConnection] in
                self?.waitingPolls.removeAll { $0 === httpConnection }
            }
            httpConnection.start()
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func checkIdle() {
        if Date().timeIntervalSince(lastPoll) > Self.extensionTimeout, waitingPolls.isEmpty, let onIdle {
            DispatchQueue.main.async(execute: onIdle)
        }
    }

    private func handle(_ request: HttpRequest, on connection: HttpConnection) {
        guard request.method == "POST" else {
            connection.respond(status: 405, contentType: "text/plain", body: Data("\(request.method) method not allowed, only POST is accepted".utf8), headers: ["Allow": "POST"])
            return
        }
        if request.path.hasPrefix(Self.extensionPathPrefix) {
            handleExtension(request, on: connection)
            return
        }

        let action = String(request.path.dropFirst())
        switch action {
        case "favicon.ico":
            connection.respond(status: 400, contentType: "", body: Data())
        case "serverVersion", "":
            connection.respondJson(status: 200, json: Data("{\"version\": \(Self.version)}".utf8))
        default:
            guard Date().timeIntervalSince(lastPoll) <= Self.extensionTimeout || !waitingPolls.isEmpty else {
                connection.respondJson(status: 503, json: Data("\"OwOtan is not connected. Enable the Yomitan API in OwOtan's settings in Safari.\"".utf8))
                return
            }
            let message: [String: Any] = ["action": action, "params": request.queryParameters, "body": String(decoding: request.body, as: UTF8.self)]
            let pendingRequest = PendingRequest(id: nextRequestId, message: message, connection: connection)
            nextRequestId += 1
            pendingRequests.append(pendingRequest)
            queue.asyncAfter(deadline: .now() + Self.requestTimeout) { [weak self] in
                self?.expire(pendingRequest)
            }
            dispatchRequests()
        }
    }

    /// Answers the extension, which only a page of a Safari extension can be: browsers set the origin of what pages send.
    private func handleExtension(_ request: HttpRequest, on connection: HttpConnection) {
        guard let origin = request.headers["origin"], origin.hasPrefix("safari-web-extension://") else {
            connection.respond(status: 403, contentType: "", body: Data())
            return
        }
        connection.extraHeaders = ["Access-Control-Allow-Origin": origin]
        lastPoll = Date()

        switch request.path.dropFirst(Self.extensionPathPrefix.count) {
        case "poll":
            waitingPolls.append(connection)
            queue.asyncAfter(deadline: .now() + Self.pollTimeout) { [weak self, weak connection] in
                guard let self, let connection, let index = self.waitingPolls.firstIndex(where: { $0 === connection }) else { return }
                self.waitingPolls.remove(at: index)
                connection.respond(status: 204, contentType: "", body: Data())
            }
            dispatchRequests()
        case "respond":
            // {"id": number, "responseStatusCode": number, "data": JSON text}
            guard
                let response = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                let id = response["id"] as? Int,
                let pendingRequest = takenRequests.removeValue(forKey: id)
            else {
                connection.respond(status: 400, contentType: "", body: Data())
                return
            }
            let status = response["responseStatusCode"] as? Int ?? 500
            let data = response["data"] as? String ?? "null"
            pendingRequest.connection.respondJson(status: status, json: Data(data.utf8))
            connection.respond(status: 204, contentType: "", body: Data())
        default:
            connection.respond(status: 404, contentType: "", body: Data())
        }
    }

    /// Gives waiting requests to waiting polls.
    private func dispatchRequests() {
        while !pendingRequests.isEmpty, !waitingPolls.isEmpty {
            let pendingRequest = pendingRequests.removeFirst()
            let poll = waitingPolls.removeFirst()
            var message = pendingRequest.message
            message["id"] = pendingRequest.id
            guard let json = try? JSONSerialization.data(withJSONObject: message) else {
                pendingRequest.connection.respondJson(status: 500, json: Data("null".utf8))
                waitingPolls.insert(poll, at: 0)
                continue
            }
            takenRequests[pendingRequest.id] = pendingRequest
            poll.respondJson(status: 200, json: json)
        }
    }

    private func expire(_ pendingRequest: PendingRequest) {
        let waiting = pendingRequests.firstIndex(where: { $0 === pendingRequest })
        if let waiting {
            pendingRequests.remove(at: waiting)
        } else if takenRequests.removeValue(forKey: pendingRequest.id) == nil {
            return
        }
        pendingRequest.connection.respondJson(status: 504, json: Data("\"OwOtan did not answer in time\"".utf8))
    }
}

struct HttpRequest {
    let method: String
    let path: String
    /// The query's parameters, each with all its values, as Python's urllib.parse.parse_qs gives them.
    let queryParameters: [String: [String]]
    /// The headers, by lowercase name.
    let headers: [String: String]
    let body: Data
}

/// One HTTP/1.1 request and its response on a connection, which is then closed.
final class HttpConnection {
    private static let maximumSize = 64 * 1024 * 1024

    var extraHeaders: [String: String] = [:]
    /// Called when the connection closes, whether after the response or because the client went away.
    var onClose: (() -> Void)?

    private let connection: NWConnection
    private let queue: DispatchQueue
    private let onRequest: (HttpRequest, HttpConnection) -> Void
    private var buffer = Data()
    private var responded = false
    /// Keeps the connection's object until it responds.
    private var retainSelf: HttpConnection?

    init(connection: NWConnection, queue: DispatchQueue, onRequest: @escaping (HttpRequest, HttpConnection) -> Void) {
        self.connection = connection
        self.queue = queue
        self.onRequest = onRequest
    }

    func start() {
        retainSelf = self
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.onClose?()
                self?.retainSelf = nil
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    func respondJson(status: Int, json: Data) {
        respond(status: status, contentType: "application/json", body: json)
    }

    func respond(status: Int, contentType: String, body: Data, headers: [String: String] = [:]) {
        guard !responded else { return }
        responded = true
        var allHeaders = [
            "Content-Type": contentType,
            "Content-Length": String(body.count),
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Connection": "close",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "*",
            "Access-Control-Allow-Headers": "*",
        ]
        allHeaders.merge(headers) { $1 }
        allHeaders.merge(extraHeaders) { $1 }
        var head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status).capitalized)\r\n"
        for (name, value) in allHeaders {
            head += "\(name): \(value)\r\n"
        }
        head += "\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { [weak self] _ in
            self?.connection.cancel()
            self?.retainSelf = nil
        })
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data {
                self.buffer.append(data)
            }
            if let request = self.parseRequest() {
                self.onRequest(request, self)
                self.watchForClose()
            } else if error != nil || isComplete || self.buffer.count > Self.maximumSize {
                self.connection.cancel()
            } else {
                self.receive()
            }
        }
    }

    /// Notices a client that goes away before the response, such as a poll that the extension gives up.
    private func watchForClose() {
        guard !responded else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] _, _, isComplete, error in
            guard let self, !self.responded else { return }
            if isComplete || error != nil {
                self.connection.cancel()
            } else {
                self.watchForClose()
            }
        }
    }

    /// The request, once all of it has arrived.
    private func parseRequest() -> HttpRequest? {
        guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buffer[buffer.startIndex..<headEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ", maxSplits: 2).map(String.init)
        guard requestLine.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let contentLength = Int(headers["content-length"] ?? "") ?? 0
        let bodyStart = headEnd.upperBound
        guard buffer.count - (bodyStart - buffer.startIndex) >= contentLength else { return nil }
        let body = buffer[bodyStart..<(bodyStart + contentLength)]

        let target = URLComponents(string: requestLine[1])
        var queryParameters: [String: [String]] = [:]
        // As parse_qs, which decodes "+" as a space before percent escapes, and leaves out empty values
        for item in target?.percentEncodedQueryItems ?? [] {
            let decode = { (text: String) in text.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? text }
            guard let value = item.value.map(decode), !value.isEmpty else { continue }
            queryParameters[decode(item.name), default: []].append(value)
        }
        return HttpRequest(method: requestLine[0], path: target?.path ?? requestLine[1], queryParameters: queryParameters, headers: headers, body: Data(body))
    }
}
