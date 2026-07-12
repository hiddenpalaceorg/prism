import { ReactNode } from "react";

type Entry =
  | {
      type: "file";
      name: string;
      date: string;
      size: string;
      md5: string;
      sha1: string;
      sha256: string;
    }
  | {
      type: "directory";
      name: string;
      date: string;
      size: string;
      contents: Entry[];
    };

function flatten(entries: Entry[], level = 0, path: string = "") {
  const files: (Entry & { level: number; path: string })[] = [];
  entries.forEach((entry) => {
    if (entry.type === "file") {
      files.push({ ...entry, level, path: `${path}/${entry.name}` });
    } else {
      files.push(
        ...flatten(entry.contents, level + 1, `${path}/${entry.name}`)
      );
    }
  });
  return files;
}

export function FileTable({ contents }: { contents: Entry[][] }) {
  const rows: ReactNode[] = [];

  const containers = contents.map((content) => {
    const files = flatten(content);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  });

  let indexes = containers.map((_) => 0);

  function getCurrent() {
    return containers.reduce((acc, container, index) => {
      if (container[indexes[index]].path < acc) {
        return container[indexes[index]].path;
      }
      return acc;
    }, "z");
  }
  // console.log(getCurrent(containers));

  let j = 0;
  while (indexes.some((i, index) => i < containers[index].length)) {
    const current = getCurrent();
    const entries: ((Entry & { level: number; path: string }) | null)[] = [];
    containers.forEach((container, index) => {
      const containerPath = container[indexes[index]]?.path;
      // console.log(containerPath, current);
      if (containerPath === current) {
        entries.push(container[indexes[index]]);
        indexes[index]++;
      } else {
        entries.push(null);
      }
      j++;
    });
    if (j > 1000) {
      break;
    }

    rows.push(
      <tr className="hover:bg-indigo-50">
        {entries.map((entry) => {
          if (!entry) {
            return (
              <>
                <td colSpan={4} />
              </>
            );
          }

          const indentStyle = { paddingLeft: entry.level * 16 + 8 };

          const hashClass =
            entries[0] &&
            "sha1" in entries[0] &&
            "sha1" in entry &&
            entries[0]?.sha1 !== entry?.sha1
              ? "text-red-500"
              : "";

          const icon =
            entry.type === "directory" ? (
              <DirIcon className="size-3" />
            ) : (
              <FileIcon className="size-3" />
            );

          return (
            <>
              <td style={indentStyle} className="py-px">
                <div className="flex gap-1 items-center">
                  {icon}
                  <div className="leading-[1w6px] pt-px">{entry.name}</div>
                </div>
              </td>

              <td className="tabular-nums px-2">{entry.date}</td>
              <td className="tabular-nums px-2 text-right">
                {Intl.NumberFormat().format(Number(entry.size))}
              </td>
              <td className={`pr-2 ${hashClass}`}>
                <pre>{"sha1" in entry && entry.sha1}</pre>
              </td>
            </>
          );
        })}
      </tr>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Date</th>
          <th>Size</th>
          <th>SHA1</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

function DirIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      className={className}
    >
      <path d="M0 96C0 60.7 28.7 32 64 32l132.1 0c19.1 0 37.4 7.6 50.9 21.1L289.9 96 448 96c35.3 0 64 28.7 64 64l0 256c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96zM64 80c-8.8 0-16 7.2-16 16l0 320c0 8.8 7.2 16 16 16l384 0c8.8 0 16-7.2 16-16l0-256c0-8.8-7.2-16-16-16l-161.4 0c-10.6 0-20.8-4.2-28.3-11.7L213.1 87c-4.5-4.5-10.6-7-17-7L64 80z" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 384 512"
      className={className}
    >
      <path d="M320 464c8.8 0 16-7.2 16-16l0-288-80 0c-17.7 0-32-14.3-32-32l0-80L64 48c-8.8 0-16 7.2-16 16l0 384c0 8.8 7.2 16 16 16l256 0zM0 64C0 28.7 28.7 0 64 0L229.5 0c17 0 33.3 6.7 45.3 18.7l90.5 90.5c12 12 18.7 28.3 18.7 45.3L384 448c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 64z" />
    </svg>
  );
}
