import Image from "next/image";
import Table from "../table3";
import Link from "next/link";

export default function Home() {
  return (
    <main className="h-full flex flex-col">
      <Link href="https://hiddenpalace.org/">
        <Image src="/logo.png" alt="Logo" width={32} height={32} />
      </Link>
      <Table />
    </main>
  );
}
