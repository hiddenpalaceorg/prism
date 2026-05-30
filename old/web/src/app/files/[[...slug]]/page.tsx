import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { FileTable } from "@/components/file-table";
import { ContainerInfo } from "@/components/container-info";
import { SimilarContainers } from "@/components/similar-containers";

async function openDb() {
  //   const db = new sqlite3.Database("./curator-cli/curator.db");
  const db = await open({
    filename: "./curator-cli/curator.db",
    driver: sqlite3.Database,
  });

  return db;

  // const containers: any[] = [];

  //   db.serialize(() => {
  //     db.each("SELECT * FROM containers", (err, row) => {
  //       //   console.log({ row, err });
  //       containers.push(row);
  //       console.log("wew");
  //     });
  //   });

  //   db.close();
}

async function Files() {
  const db = await openDb();

  const containers: any = await db.all("SELECT * FROM containers");

  return (
    <div>
      {containers.map((container) => {
        return (
          <div key={container.sha1}>
            <a
              className="text-indigo-600"
              href={`files/${container.sha1}/${container.name}`}
            >
              {container.name}
            </a>
          </div>
        );
      })}
    </div>
  );
}

export default async function File({ params }: { params: any }) {
  // console.log(params.slug);
  const slug = params.slug;

  // console.log({ params });

  if (slug == null || slug.length === 0) {
    return <Files />;
  }

  let compares = [];
  // console.log(slug);
  if (slug.includes("compare")) {
    compares = (slug[slug.indexOf("compare") + 1] ?? "").split(",");
  }

  // console.log(compares);

  // if (params)
  const db = await openDb();

  const sha1 = slug[0];

  // console.log(sha1);

  const marks = ["_", ...compares].map((_) => "?").join(",");
  const containers: any = await db.all(
    `select * from containers where sha1 in (${marks})`,
    [sha1, ...compares]
  );

  const container = containers[0];

  const similarFiles = await db.all(
    `select 
      f1.*, 
      f2.container as f2_container,
      f2.name as f2_name,
      f2.sha1 as f2_sha1,
      c2.name as f2_container_name
    from files f1 
      left join files f2 
      on f1.container != f2.container 
        and (f1.name = f2.name or f1.sha1 = f2.sha1)
      left join containers c2 
      on f2.container = c2.sha1
      where f1.container = ?`,
    [sha1]
  );

  // console.log(similarFiles);

  // console.log(containers);

  // console.log(container);

  // <FileTable contents={contents} />

  const info = JSON.parse(container.info);
  const contents = containers.map((container: any) =>
    JSON.parse(container.contents)
  );

  return (
    <div className="text-[12px]">
      <h2 className="mt-3 text-lg mb-2 font-medium">{container.name}</h2>
      <ContainerInfo info={info} />
      <h2 className="mt-3 text-lg mb-2 font-medium">Files</h2>
      <FileTable contents={contents} />
      <h2 className="mt-3 text-lg mb-2 font-medium">Similar</h2>
      <SimilarContainers
        similarFiles={similarFiles}
        currentContainer={sha1}
      />
      <h2 className="mt-3 text-lg mb-2 font-medium">DAT</h2>
      <pre>{container.xml}</pre>
    </div>
  );
}
