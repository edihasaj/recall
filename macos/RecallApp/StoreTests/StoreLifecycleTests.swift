import AppKit
import Security
import SwiftUI
import WebKit
import XCTest
@testable import Recall

@MainActor
final class StoreLifecycleTests: XCTestCase {
    func testClosedWindowReopens() throws {
        let delegate = StoreAppDelegate()
        delegate.showRecall()
        let window = try XCTUnwrap(delegate.window)
        XCTAssertTrue(window.isVisible)
        window.close()
        XCTAssertFalse(window.isVisible)
        delegate.showRecall()
        XCTAssertTrue(window.isVisible)
        XCTAssertTrue(delegate.window === window)
        window.orderOut(nil)
    }

    func testExternalMCPClient() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let runtime = StoreRuntime(port: 37902, webPort: 37903, dataDirectory: directory)
        addTeardownBlock { await runtime.stop() }
        runtime.start()
        try await waitForReady(runtime)
        _ = try await runtime.request("/store/memory", body: ["text": "Use uv for Python dependencies."])
        print("Store endpoint is ready for the external MCP client.")
        for _ in 0..<240 {
            let response = try await runtime.request("/memories")
            let memories = response["memories"] as? [[String: Any]] ?? []
            if memories.contains(where: { $0["text"] as? String == "External MCP client verified." }) {
                await runtime.stop()
                return
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTFail("External MCP client did not complete verification")
    }

    func testSandboxedMemoryHooksAndRestart() async throws {
        try verifySandbox()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let runtime = StoreRuntime(port: 37902, webPort: 37903, dataDirectory: directory)
        addTeardownBlock { await runtime.stop() }
        runtime.start()
        try await waitForReady(runtime)
        let health = try await runtime.request("/health")
        XCTAssertEqual(health["status"] as? String, "ok")
        let correction = try await runtime.request("/store/memory", body: [
            "text": "Use uv for Python dependency commands.",
        ])
        print("Sandbox correction keys: \(correction.keys.sorted())")
        let identifier = try XCTUnwrap(correction["id"] as? String)
        let hook = try await runtime.request("/hook/agent/codex/SessionStart", body: [
            "session_id": "recall-store-proof", "cwd": directory.path, "repo": "store-proof/fixture",
        ])
        let injection = try XCTUnwrap(hook["hookSpecificOutput"] as? [String: Any])
        XCTAssertTrue((injection["additionalContext"] as? String)?.contains("uv") == true)
        let updates = try await runtime.request("/update")
        XCTAssertEqual(updates["managed_by"] as? String, "mac-app-store")
        await runtime.restart()
        try await waitForReady(runtime)
        let restored = try await runtime.request("/memory/\(identifier)")
        XCTAssertEqual(restored["text"] as? String, "Use uv for Python dependency commands.")
        await runtime.stop()
        XCTAssertFalse(runtime.ready)
        print("Signed sandbox database, HTTP hooks, restart persistence, and service shutdown verified.")
    }

    func testNativeScreenshots() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let runtime = StoreRuntime(port: 37902, webPort: 37903, dataDirectory: directory)
        addTeardownBlock { await runtime.stop() }
        runtime.start()
        try await waitForReady(runtime)
        for rule in ["Use uv for dependencies in pyproject.toml.",
                     "src/api.ts uses zod to validate requests.",
                     "src/api.ts is tested by test/api.test.ts."] {
            let response = try await runtime.request("/store/memory", body: [
                "repo": "demo/project", "text": rule,
            ])
            XCTAssertNotNil(response["id"] as? String)
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 680), configuration: config)
        let window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable],
                              backing: .buffered, defer: false)
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        for (path, name) in [("", "01-memory"), ("graph", "02-graph")] {
            web.load(URLRequest(url: runtime.dashboardURL.appendingPathComponent(path)))
            try await Task.sleep(for: .seconds(4))
            if path == "graph" {
                _ = try await web.evaluateJavaScript(
                    "Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '2D')?.click()")
                try await Task.sleep(for: .milliseconds(400))
            }
            let image = try await web.takeSnapshot(configuration: nil)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            let shot = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
            shot.name = name
            shot.lifetime = .keepAlways
            add(shot)
        }
        window.orderOut(nil)
        await runtime.stop()
    }

    private func waitForReady(_ runtime: StoreRuntime) async throws {
        for _ in 0..<160 {
            if runtime.ready { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        let log = try? String(contentsOf: runtime.dataDirectory.appendingPathComponent("service.log"),
                              encoding: .utf8)
        XCTFail("\(runtime.error ?? "Local service failed to start")\n\(log ?? "No service log")")
        throw NSError(domain: "StoreProof", code: 1)
    }

    private func verifySandbox() throws {
        var code: SecCode?
        XCTAssertEqual(SecCodeCopySelf([], &code), errSecSuccess)
        var staticCode: SecStaticCode?
        XCTAssertEqual(SecCodeCopyStaticCode(try XCTUnwrap(code), [], &staticCode), errSecSuccess)
        var information: CFDictionary?
        XCTAssertEqual(SecCodeCopySigningInformation(try XCTUnwrap(staticCode),
            SecCSFlags(rawValue: kSecCSSigningInformation), &information), errSecSuccess)
        let details = try XCTUnwrap(information as? [String: Any])
        let entitlements = try XCTUnwrap(details[kSecCodeInfoEntitlementsDict as String] as? [String: Any])
        XCTAssertEqual(entitlements["com.apple.security.app-sandbox"] as? Bool, true)
    }
}
