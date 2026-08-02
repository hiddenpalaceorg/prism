export interface BuildOgMediaImage<T> {
  image: T;
  label: string | null;
}

export function buildOgObjectFit(index: number, mediaCount: number): "contain" | "cover" {
  return index < mediaCount ? "contain" : "cover";
}

export function selectBuildOgImages<T>(
  media: readonly BuildOgMediaImage<T>[],
  assets: readonly T[],
  limit = 3,
): T[] {
  if (limit <= 0) return [];

  const fronts = media
    .filter(({ label }) => label === "front")
    .map(({ image }) => image);
  const insert = media.find(
    ({ label }) => label !== "front" && label !== "back",
  );

  return [
    ...fronts,
    ...(insert ? [insert.image] : []),
    ...assets,
  ].slice(0, limit);
}
