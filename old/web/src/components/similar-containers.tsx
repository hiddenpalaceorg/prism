import Link from "next/link";

export function SimilarContainers({
  similarFiles,
  currentContainer,
}: {
  similarFiles: any;
  currentContainer: string;
}) {
  const fileSet = new Set();
  const containerPoints = new Map();
  const containerNames = new Map();

  for (const file of similarFiles) {
    fileSet.add(file.name);

    if (file.f2_container === null) {
      continue;
    }

    let points = 0;
    if (file.name === file.f2_name) {
      points += 1;
    }
    if (file.sha1 === file.f2_sha1) {
      points += 1;
    }

    containerPoints.set(
      file.f2_container,
      (containerPoints.get(file.f2_container) ?? 0) + points
    );
    containerNames.set(file.f2_container, file.f2_container_name);
  }
  const sortedContainers = Array.from(containerPoints.entries()).sort(
    (a, b) => b[1] - a[1]
  );
//   const currentContainer = sortedContainers[0][0].sha1;
  return (
    <div>
      {sortedContainers.map(([container, points]) => {
        const similarity = points / (fileSet.size * 2);
        return (
          <div key={container}>
            <Link href={`/files/${container}/${containerNames.get(container)}`}>
              <span className="underline">{containerNames.get(container)}</span>: {(similarity * 100).toFixed(2)}%
            </Link>
            {" "}({<Link href={`/files/${currentContainer}/compare/${container}`} className="underline">compare</Link>})
          </div>
        );
      })}
    </div>
  );

  //   return <pre>{JSON.stringify(Array.from(containerPoints.entries()), null, 2)}</pre>;
}
