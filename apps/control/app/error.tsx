"use client";

/** What a page shows when its data couldn't be read; the details are in the service's log. */
export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <section className="panel">
      <h1>This page couldn&apos;t be shown</h1>
      <p className="lead">
        The control panel couldn&apos;t read what it needs. The control service&apos;s log on Railway says why
        {error.digest ? ` (look for ${error.digest})` : ""}.
      </p>
    </section>
  );
}
