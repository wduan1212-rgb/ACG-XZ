export const IS_GITHUB_PAGES = process.env.NEXT_PUBLIC_GITHUB_PAGES === "1";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const IS_PLATFORM_EMBED = process.env.NEXT_PUBLIC_PLATFORM_EMBED === "1";

export function publicAsset(path: string): string {
  if (!BASE_PATH || !path.startsWith("/")) return path;
  return `${BASE_PATH}${path}`;
}

function staticHashHref(path: string): string {
  const route = path.startsWith("/") ? path : `/${path}`;
  const basePath = BASE_PATH
    ? `/${BASE_PATH.replace(/^\/+|\/+$/g, "")}`
    : "";
  const query = IS_PLATFORM_EMBED ? "?embed=1" : "";
  return `${basePath}/${query}#${route}`;
}

export function homeHref(): string {
  return IS_GITHUB_PAGES ? staticHashHref("/") : "/";
}

export function projectHref(projectId: string): string {
  const id = encodeURIComponent(projectId);
  return IS_GITHUB_PAGES ? staticHashHref(`/project/${id}`) : `/project/${id}`;
}

export function navigateToProject(
  router: { push: (href: string) => void },
  projectId: string,
) {
  if (IS_GITHUB_PAGES && typeof window !== "undefined") {
    window.location.hash = `/project/${encodeURIComponent(projectId)}`;
    return;
  }
  router.push(projectHref(projectId));
}

export function navigateHome(router: { push: (href: string) => void }) {
  if (IS_GITHUB_PAGES && typeof window !== "undefined") {
    window.location.hash = "/";
    return;
  }
  router.push(homeHref());
}
