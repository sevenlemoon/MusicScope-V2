"use client";

import Image from "next/image";
import { useState } from "react";

export function Artwork({ src, alt, sizes = "(max-width: 767px) 45vw, 220px", className = "" }: { src?: string | null; alt: string; sizes?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className={`library-artwork ${className}`.trim()}>{src && !failed ? <Image src={src} alt={alt} fill sizes={sizes} unoptimized onError={() => setFailed(true)} /> : <span aria-hidden="true">M</span>}</div>;
}
