"use client";

import builds from "@/builds.json";
import { DataTable } from "./data-table";
import { useMemo } from "react";
import { ColumnDef } from "@tanstack/react-table";
type Build = any;

export default function Table() {
  function sortableHeader(name: string) {
    const fn = ({ column }: any) => {
      return (
        <div
          // variant="ghost"
          className="cursor-pointer"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          {name}
          {/* <ArrowUpDown className="ml-2 h-4 w-4" /> */}
        </div>
      );
    };
    return fn;
  }
  function column(name: string) {
    return {
      accessorKey: name,
      header: sortableHeader(name),
    };
  }
  const columns = useMemo<ColumnDef<Build>[]>(
    () => [
      column("Filename"),
      column("Executable Timestamp"),
      column("Volume Creation Date"),
      column("Executable Filename"),
      column("Executable Hash (MD5)"),
    ],
    []
  );

  return (
    <main className="h-full w-full">
      <DataTable columns={columns} data={builds as Build[]} />
    </main>
  );
}
