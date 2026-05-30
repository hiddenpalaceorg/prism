import Foundation

/// Decoded view of the canonical build record (`AnalysisSummary.json`), used to render
/// the formatted Overview. Mirrors curator-core's schema; decoded with
/// `.convertFromSnakeCase` so Swift properties stay camelCase. Every field is optional —
/// the UI shows only what's present.
struct RecordDoc: Decodable {
    var image: ImageInfo?
    var info: DiscInfo?
    var composites: Composites?
    var structural: Structural?

    struct ImageInfo: Decodable {
        var name: String?
        var size: UInt64?
        var md5: String?
        var sha1: String?
        var sha256: String?
    }

    struct DiscInfo: Decodable {
        var system: String?
        var systemIdentifier: String?
        var header: Header?
        var volume: Volume?
        var exe: Exe?
        var discType: String?
    }

    struct Header: Decodable {
        var title: String?
        var productNumber: String?
        var productVersion: String?
        var releaseDate: String?
        var makerId: String?
        var deviceInfo: String?
        var regions: String?

        var isEmpty: Bool {
            title == nil && productNumber == nil && productVersion == nil
                && releaseDate == nil && makerId == nil && deviceInfo == nil && regions == nil
        }
    }

    struct Volume: Decodable {
        var identifier: String?
        var setIdentifier: String?
        var creationDate: String?
        var modificationDate: String?

        var isEmpty: Bool {
            identifier == nil && setIdentifier == nil && creationDate == nil && modificationDate == nil
        }
    }

    struct Exe: Decodable {
        var filename: String?
        var date: String?
    }

    struct Composites: Decodable {
        var contentHash: String?
        var filteredContentHash: String?
        var hashExe: String?
        var mostRecentFile: MostRecentFile?
        var incompleteFiles: Int?
    }

    struct MostRecentFile: Decodable {
        var path: String?
        var date: String?
        var hash: String?
    }

    struct Structural: Decodable {
        var fileCount: UInt64?
        var totalSize: UInt64?
        var maxDepth: Int?
        var extHistogram: [String: UInt64]?
    }

    static func decode(_ json: String) -> RecordDoc? {
        guard let data = json.data(using: .utf8) else { return nil }
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        return try? dec.decode(RecordDoc.self, from: data)
    }
}

/// Prettify the assorted date strings the adapter emits: a bare `YYYYMMDD` (e.g. Saturn
/// header dates like `19970414`) becomes `1997-04-14`; anything else is returned as-is.
func prettyDate(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    if s.count == 8, s.allSatisfy(\.isNumber) {
        return "\(s.prefix(4))-\(s.dropFirst(4).prefix(2))-\(s.suffix(2))"
    }
    return s
}

/// "iso×1, bin×3, …" — the busiest file extensions, for the Overview's structure section.
func topExtensions(_ hist: [String: UInt64], limit: Int = 8) -> String {
    hist.sorted { $0.value > $1.value }
        .prefix(limit)
        .map { "\($0.key.isEmpty ? "(none)" : $0.key)×\($0.value)" }
        .joined(separator: ", ")
}
