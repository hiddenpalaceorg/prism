using System.Text.Json;
using System.Text.Json.Serialization;

namespace PrismWin;

/// Decoded view of the canonical build record (`AnalysisSummary.Json`), used to
/// render the formatted Overview. Mirrors prism-core's schema (and the macOS
/// RecordDoc). Every field is optional, the UI shows only what's present.
public sealed class RecordDoc
{
    public ImageInfo? Image { get; set; }
    public DiscInfo? Info { get; set; }
    public CompositesInfo? Composites { get; set; }
    public StructuralInfo? Structural { get; set; }

    public sealed class ImageInfo
    {
        public string? Name { get; set; }
        public ulong? Size { get; set; }
        public string? Md5 { get; set; }
        public string? Sha1 { get; set; }
        public string? Sha256 { get; set; }
    }

    public sealed class DiscInfo
    {
        public string? System { get; set; }
        public string? SystemIdentifier { get; set; }
        public HeaderInfo? Header { get; set; }
        public VolumeInfo? Volume { get; set; }
        public ExeInfo? Exe { get; set; }
        public AltExeInfo? AltExe { get; set; }
        public SfoInfo? Sfo { get; set; }
        public string? DiscType { get; set; }
    }

    public sealed class HeaderInfo
    {
        public string? Title { get; set; }
        public string? ProductNumber { get; set; }
        public string? ProductVersion { get; set; }
        public string? ReleaseDate { get; set; }
        public string? MakerId { get; set; }
        public string? DeviceInfo { get; set; }
        public string? Regions { get; set; }

        [JsonIgnore]
        public bool IsEmpty => Title == null && ProductNumber == null && ProductVersion == null
            && ReleaseDate == null && MakerId == null && DeviceInfo == null && Regions == null;
    }

    public sealed class VolumeInfo
    {
        public string? Identifier { get; set; }
        public string? SetIdentifier { get; set; }
        public string? CreationDate { get; set; }
        public string? ModificationDate { get; set; }
        public string? ExpirationDate { get; set; }
        public string? EffectiveDate { get; set; }

        [JsonIgnore]
        public bool IsEmpty => Identifier == null && SetIdentifier == null && CreationDate == null
            && ModificationDate == null && ExpirationDate == null && EffectiveDate == null;
    }

    public sealed class ExeInfo
    {
        public string? Filename { get; set; }
        public string? Date { get; set; }
        public string? SigningType { get; set; }
        public ulong? NumSymbols { get; set; }
    }

    public sealed class AltExeInfo
    {
        public string? Filename { get; set; }
        public string? Date { get; set; }
        public string? Md5 { get; set; }
    }

    public sealed class SfoInfo
    {
        public string? Title { get; set; }
        public string? DiscId { get; set; }
        public string? DiscVersion { get; set; }
        public string? Category { get; set; }
        public string? ParentalLevel { get; set; }
        public string? SystemVersion { get; set; }

        [JsonIgnore]
        public bool IsEmpty => Title == null && DiscId == null && DiscVersion == null
            && Category == null && ParentalLevel == null && SystemVersion == null;
    }

    public sealed class CompositesInfo
    {
        public string? ContentHash { get; set; }
        public string? FilteredContentHash { get; set; }
        public string? HashExe { get; set; }
        public MostRecentFileInfo? MostRecentFile { get; set; }
        public long? IncompleteFiles { get; set; }
    }

    public sealed class MostRecentFileInfo
    {
        public string? Path { get; set; }
        public string? Date { get; set; }
        public string? Hash { get; set; }
    }

    public sealed class StructuralInfo
    {
        public ulong? FileCount { get; set; }
        public ulong? TotalSize { get; set; }
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static RecordDoc? Decode(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<RecordDoc>(json, Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
