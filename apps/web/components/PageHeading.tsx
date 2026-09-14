export function PageHeading({ index, eyebrow, title, body }: { index: string; eyebrow: string; title: string; body: string }) {
  return <header className="page-heading">
    <div className="page-index" aria-hidden="true">{index}</div>
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-lede">{body}</p></div>
  </header>;
}

