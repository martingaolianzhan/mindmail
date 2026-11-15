/** Segment-boundary match shared by middleware and client command routing. */
export function isDemoPath(pathname: string | null): boolean {
    return pathname === "/demo" || !!pathname?.startsWith("/demo/");
}
