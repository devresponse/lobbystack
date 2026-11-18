import Link from "next/link";

export default function NotFound() {
  return (
    <section className="panel">
      <h1>Not found</h1>
      <p className="lead">
        Nothing here has that address. Find it from <Link href="/businesses">Businesses</Link> or <Link href="/accounts">Accounts</Link>.
      </p>
    </section>
  );
}
