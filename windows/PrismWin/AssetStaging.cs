using uniffi.prism_ffi;

namespace PrismWin;

/// Copies asset blobs into per-sha temp files so the shell can pick a handler
/// by extension (store blobs are extensionless). Mirrors prism-win: TGA images
/// stage as BMP because stock Windows has no TGA handler.
internal static class AssetStaging
{
    /// The asset's original filename, sanitized for use in a Windows path.
    public static string SafeName(AssetInfo asset)
    {
        var name = Format.LastComponent(asset.Path);
        var safe = new string(name.Select(c =>
            c is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*' || c < ' ' ? '_' : c).ToArray());
        return safe.Trim('.', ' ').Length == 0 ? asset.Sha256 : safe;
    }

    private static string TempDir(AssetInfo asset)
    {
        var dir = Path.Combine(Path.GetTempPath(), "prism-assets", asset.Sha256);
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// Copy a blob under its original (sanitized) filename. Content-addressed,
    /// so an existing copy is reused.
    public static string Materialize(AssetInfo asset, string blob)
    {
        var dest = Path.Combine(TempDir(asset), SafeName(asset));
        if (!File.Exists(dest))
        {
            File.Copy(blob, dest);
        }
        return dest;
    }

    /// Stage a TGA image as a 32bpp BMP the shell can open. An undecodable file
    /// is staged raw instead, so users with a TGA-capable viewer can still try it.
    public static string MaterializeTga(AssetInfo asset, string blob)
    {
        var dest = Path.Combine(TempDir(asset), SafeName(asset) + ".bmp");
        if (File.Exists(dest))
        {
            return dest;
        }
        var bmp = NativeMethods.TgaToBmp(File.ReadAllBytes(blob));
        if (bmp == null)
        {
            return Materialize(asset, blob);
        }
        File.WriteAllBytes(dest, bmp);
        return dest;
    }
}
