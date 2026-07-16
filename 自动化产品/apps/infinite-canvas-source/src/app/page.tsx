import { GithubPagesApp } from "@/components/GithubPagesApp";
import { HomeView } from "@/components/home/HomeView";
import { IS_GITHUB_PAGES } from "@/lib/runtime";

export default function Page() {
  if (IS_GITHUB_PAGES) return <GithubPagesApp />;
  return <HomeView />;
}
