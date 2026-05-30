import Foundation
import SwiftUI
import AppKit
import CuratorKit

/// A single live progress counter (image hashing, per-archive extraction, …).
struct CounterState: Identifiable {
    let id: UInt64
    var label: String
    var unit: String
    var total: Double?
    var count: Double = 0

    var fraction: Double? {
        guard let total, total > 0 else { return nil }
        return min(1, count / total)
    }
}

/// What document the viewer shows.
enum DocMode: String, CaseIterable, Identifiable {
    case xml = "XML"
    case json = "JSON"
    var id: String { rawValue }
}

/// Forwards UniFFI progress callbacks (delivered on a background thread) to a main-actor sink.
final class ProgressForwarder: ProgressListener, @unchecked Sendable {
    enum Update {
        case batch(index: UInt64, total: UInt64, name: String)
        case open(id: UInt64, label: String, unit: String, total: Double?)
        case progress(id: UInt64, count: Double)
        case close(id: UInt64)
        case message(String)
    }

    private let sink: @Sendable (Update) -> Void
    init(_ sink: @escaping @Sendable (Update) -> Void) { self.sink = sink }

    func onBatch(index: UInt64, total: UInt64, name: String) { sink(.batch(index: index, total: total, name: name)) }
    func onCounterOpen(id: UInt64, label: String, unit: String, total: Double?) { sink(.open(id: id, label: label, unit: unit, total: total)) }
    func onProgress(id: UInt64, count: Double) { sink(.progress(id: id, count: count)) }
    func onCounterClose(id: UInt64) { sink(.close(id: id)) }
    func onMessage(text: String) { sink(.message(text)) }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var summary: AnalysisSummary?
    @Published var rootNodes: [DiscNode] = []
    @Published var nodeIndex: [UUID: DiscNode] = [:]
    @Published var selection: UUID?
    @Published var isWorking = false
    @Published var status = "Open a disc image, container, or folder to analyze."
    @Published var counters: [CounterState] = []
    @Published var docMode: DocMode = .xml
    @Published var errorMessage: String?
    @Published var catalogCount: UInt64 = 0

    private var engine: Engine?
    private var cancelHandle: CancelHandle?

    var selectedNode: DiscNode? { selection.flatMap { nodeIndex[$0] } }

    /// Resolve the adapter location from the environment, else dev defaults.
    private func makeEngine() throws -> Engine {
        if let engine { return engine }
        let env = ProcessInfo.processInfo.environment
        let bin = env["CURATOR_ADAPTER_BIN"]
        let dir = env["CURATOR_ADAPTER_DIR"] ?? "../ps2exe-adapter"
        let e = try Engine(adapterDir: bin == nil ? dir : nil, adapterBin: bin, dataDir: env["CURATOR_DATA_DIR"])
        engine = e
        catalogCount = (try? e.catalogSize()) ?? 0
        return e
    }

    func refreshCatalogCount() {
        catalogCount = (try? engine?.catalogSize()) ?? catalogCount
    }

    func analyze(url: URL) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        counters = []
        status = "Analyzing \(url.lastPathComponent)…"
        let cancel = CancelHandle()
        cancelHandle = cancel

        let forwarder = ProgressForwarder { [weak self] update in
            Task { @MainActor in self?.apply(update) }
        }
        let path = url.path

        Task.detached(priority: .userInitiated) {
            do {
                let engine = try await MainActor.run { try self.makeEngine() }
                let summary = try engine.analyze(path: path, listener: forwarder, cancel: cancel)
                await MainActor.run { self.finish(summary: summary) }
            } catch CuratorError.Cancelled {
                await MainActor.run { self.fail("Cancelled.") }
            } catch let CuratorError.Failed(message) {
                await MainActor.run { self.fail(message) }
            } catch {
                await MainActor.run { self.fail("\(error)") }
            }
        }
    }

    func cancel() {
        cancelHandle?.cancel()
        status = "Cancelling…"
    }

    /// Present the native open panel (files or folders) and analyze the choice.
    func openDialog() {
        guard !isWorking else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Analyze"
        if panel.runModal() == .OK, let url = panel.url {
            analyze(url: url)
        }
    }

    // MARK: - main-actor sinks

    private func apply(_ update: ProgressForwarder.Update) {
        switch update {
        case let .batch(index, total, name):
            status = "Item \(index + 1) of \(total): \((name as NSString).lastPathComponent)"
        case let .open(id, label, unit, total):
            counters.removeAll { $0.id == id }
            counters.append(CounterState(id: id, label: label, unit: unit, total: total))
        case let .progress(id, count):
            if let i = counters.firstIndex(where: { $0.id == id }) { counters[i].count = count }
        case let .close(id):
            counters.removeAll { $0.id == id }
        case let .message(text):
            status = text
        }
    }

    private func finish(summary: AnalysisSummary) {
        self.summary = summary
        rootNodes = summary.tree.map(DiscNode.init)
        var idx: [UUID: DiscNode] = [:]
        rootNodes.forEach { $0.index(into: &idx) }
        nodeIndex = idx
        selection = nil
        counters = []
        isWorking = false
        cancelHandle = nil
        status = "\(summary.fromCache ? "Loaded from cache" : "Analyzed") — \(summary.system), \(summary.fileCount) files, \(humanSize(summary.totalSize))."
        refreshCatalogCount()
    }

    private func fail(_ message: String) {
        isWorking = false
        cancelHandle = nil
        counters = []
        if message == "Cancelled." {
            status = "Cancelled."
        } else {
            errorMessage = message
            status = "Failed."
        }
    }
}
