// Headless runtime check for the UniFFI bridge — no GUI session required.
// Exercises: Engine constructor, a catalog query, the ProgressListener callback
// (image hashing emits real events), cancellation, and error propagation.
//
//   cargo build -p curator-ffi && (cd macos && swift run curator-probe)
import Foundation
import CuratorKit

final class PrintListener: ProgressListener, @unchecked Sendable {
    func onBatch(index: UInt64, total: UInt64, name: String) {
        print("  [batch] \(index + 1)/\(total) \(name)")
    }
    func onCounterOpen(id: UInt64, label: String, unit: String, total: Double?) {
        let t = total.map { String(Int($0)) } ?? "?"
        print("  [open #\(id)] \(label) — \(t) \(unit)")
    }
    func onProgress(id: UInt64, count: Double) { /* high-frequency; elided */ }
    func onCounterClose(id: UInt64) { print("  [close #\(id)]") }
    func onMessage(text: String) { print("  [msg] \(text)") }
}

let fm = FileManager.default
let tmp = fm.temporaryDirectory.appendingPathComponent("curator-probe-\(getpid())")
try? fm.createDirectory(at: tmp, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: tmp) }

let engine = try Engine(
    adapterDir: "../ps2exe-adapter",
    adapterBin: nil,
    dataDir: tmp.appendingPathComponent("data").path
)
print("1. catalogSize() ->", try engine.catalogSize(), "(fresh data dir) ✓")

// 2. Cancellation: pre-trip the handle; hashing must unwind as .cancelled.
let big = tmp.appendingPathComponent("big.bin")
fm.createFile(atPath: big.path, contents: Data(count: 32 * 1024 * 1024))
let cancel = CancelHandle()
cancel.cancel()
do {
    _ = try engine.analyze(path: big.path, listener: PrintListener(), cancel: cancel)
    print("2. cancellation -> FAILED (analyze returned)")
} catch CuratorError.Cancelled {
    print("2. cancellation -> .Cancelled ✓")
} catch {
    print("2. cancellation -> unexpected:", error)
}

// 3. Progress + adapter path: a tiny non-disc file. Hashing fires real progress
//    events; the adapter then rejects it (not a disc) → error propagates as Swift throw.
let junk = tmp.appendingPathComponent("not-a-disc.bin")
fm.createFile(atPath: junk.path, contents: Data((0..<(1024 * 256)).map { UInt8($0 & 0xff) }))
print("3. analyze(non-disc) — expecting progress events then a thrown error:")
do {
    let summary = try engine.analyze(path: junk.path, listener: PrintListener(), cancel: nil)
    print("   returned (unexpected for junk): \(summary.sha256)")
} catch let CuratorError.Failed(message) {
    print("   threw .Failed as expected: \(message.prefix(120))")
} catch {
    print("   threw:", error)
}

print("probe done.")
