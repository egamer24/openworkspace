import {
  ChevronDown,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  GitPullRequestArrow,
  History,
  Settings,
  Tag,
} from "lucide-react";
import { lazy, Suspense } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLanguages, useRefs, useRepository } from "./code-api";
import { CopyField } from "./copy-field";
import { BlobView, Breadcrumbs, FileFinder, TreeView } from "./repo-code";
import { CommitsView, CommitView } from "./repo-history";
import { ErrorText, Loading, Panel, PanelHeader, repoLinks, type RepoLinks } from "./repo-shared";
import { RepoFileTree } from "./repo-tree";

const BranchesView = lazy(() => import("./repo-refs").then((module) => ({ default: module.BranchesView })));
const TagsView = lazy(() => import("./repo-refs").then((module) => ({ default: module.TagsView })));
const CompareView = lazy(() => import("./repo-compare").then((module) => ({ default: module.CompareView })));
const SettingsView = lazy(() => import("./repo-settings").then((module) => ({ default: module.SettingsView })));
const TaskList = lazy(() => import("@/tasks/task-list").then((module) => ({ default: module.TaskList })));
const NewTaskView = lazy(() => import("@/tasks/new-task").then((module) => ({ default: module.NewTaskView })));
const TaskPage = lazy(() => import("@/tasks/task-page").then((module) => ({ default: module.TaskPage })));

type View =
  | { kind: "tree"; path: string }
  | { kind: "blob"; path: string }
  | { kind: "commits"; path: string }
  | { kind: "commit"; hash: string }
  | { kind: "branches" }
  | { kind: "tags" }
  | { kind: "compare"; spec: string }
  | { kind: "settings" }
  | { kind: "tasks" }
  | { kind: "new-task" }
  | { kind: "task"; number: number; tab: string };

type Tab = "code" | "tasks" | "commits" | "branches" | "tags" | "settings";

function parseView(rest: string): View {
  const [section = "", ...parts] = rest.split("/");
  const path = parts.map(decodeURIComponent).join("/");
  switch (section) {
    case "blob":
      return { kind: "blob", path };
    case "tree":
      return { kind: "tree", path };
    case "commits":
      return { kind: "commits", path };
    case "commit":
      return parts[0] ? { kind: "commit", hash: parts[0] } : { kind: "commits", path: "" };
    case "branches":
      return { kind: "branches" };
    case "tags":
      return { kind: "tags" };
    case "compare":
      return { kind: "compare", spec: parts.join("/") };
    case "settings":
      return { kind: "settings" };
    case "tasks": {
      if (parts[0] === "new") return { kind: "new-task" };
      const number = Number(parts[0]);
      if (Number.isSafeInteger(number) && number > 0) {
        return { kind: "task", number, tab: parts[1] ?? "" };
      }
      return { kind: "tasks" };
    }
    default:
      return { kind: "tree", path: "" };
  }
}

function tabFor(view: View): Tab {
  switch (view.kind) {
    case "commits":
    case "commit":
      return "commits";
    case "branches":
    case "compare":
      return "branches";
    case "tags":
      return "tags";
    case "settings":
      return "settings";
    case "tasks":
    case "new-task":
    case "task":
      return "tasks";
    default:
      return "code";
  }
}

function RefPicker({
  repo,
  refName,
  onChange,
}: {
  repo: string;
  refName: string;
  onChange: (ref: string) => void;
}) {
  const refs = useRefs(repo);
  const branches = refs.data?.refs.branches ?? [];
  const tags = refs.data?.refs.tags ?? [];
  const known = branches.some((branch) => branch.name === refName)
    || tags.some((tag) => tag.name === refName);
  const isTag = tags.some((tag) => tag.name === refName);
  return (
    <Select value={refName} onValueChange={(value) => value && onChange(value)}>
      <SelectTrigger className="h-8 w-auto max-w-56 font-mono text-xs" aria-label="Branch or tag">
        {isTag ? <Tag className="size-3.5" /> : <GitBranch className="size-3.5" />}
        <SelectValue>{/^[0-9a-f]{40}$/u.test(refName) ? refName.slice(0, 7) : refName}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectLabel>Branches</SelectLabel>
          {branches.map((branch) => (
            <SelectItem key={`b:${branch.name}`} value={branch.name} className="font-mono text-xs">
              {branch.name}
            </SelectItem>
          ))}
          {!known && (
            <SelectItem value={refName} className="font-mono text-xs">
              {/^[0-9a-f]{40}$/u.test(refName) ? refName.slice(0, 7) : refName}
            </SelectItem>
          )}
        </SelectGroup>
        {tags.length > 0 && (
          <SelectGroup>
            <SelectLabel>Tags</SelectLabel>
            {tags.map((tag) => (
              <SelectItem key={`t:${tag.name}`} value={tag.name} className="font-mono text-xs">
                {tag.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

function CloneMenu({ remote }: { remote: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" />}>
        <FileCode2 /> Clone <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(26rem,calc(100vw-2rem))] space-y-2 p-3">
        <p className="text-sm font-medium">Clone with HTTPS</p>
        <CopyField value={remote} label="Clone URL" />
        <CopyField value={`git clone ${remote}`} label="Clone command" />
        <p className="text-xs text-muted-foreground">
          Use any username and an account API token from Settings → MCP as the password.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LanguagesPanel({ repo, refName }: { repo: string; refName: string }) {
  const languages = useLanguages(repo, refName, true);
  const items = languages.data?.languages ?? [];
  if (languages.isPending) {
    return (
      <div className="space-y-2 border-t border-border/70 p-4">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="h-2 animate-pulse rounded-full bg-muted" />
      </div>
    );
  }
  if (items.length === 0) return null;
  // Tiny shares still get a visible sliver, like GitHub's bar.
  const shown = items.filter((item) => item.percent >= 0.1);
  return (
    <div className="space-y-3 border-t border-border/70 p-4">
      <h3 className="text-sm font-semibold">Languages</h3>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Language breakdown">
        {shown.map((item) => (
          <span
            key={item.name}
            title={`${item.name} ${item.percent.toFixed(1)}%`}
            className="h-full min-w-0.5"
            style={{ width: `${item.percent}%`, backgroundColor: item.color }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {items.map((item) => (
          <li key={item.name} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
            <span className="font-semibold">{item.name}</span>
            <span className="text-muted-foreground">
              {item.percent < 0.1 ? "<0.1" : item.percent.toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
      {languages.data?.partial && (
        <p className="text-xs text-muted-foreground">Measured from part of a large repository.</p>
      )}
    </div>
  );
}

function AboutPanel({
  repo,
  refName,
  description,
  links,
  branchCount,
  tagCount,
  openTasks,
}: {
  repo: string;
  refName: string;
  description: string | null;
  links: RepoLinks;
  branchCount: number;
  tagCount: number;
  openTasks: number;
}) {
  return (
    <Panel>
      <PanelHeader><span className="font-semibold">About</span></PanelHeader>
      <div className="space-y-3 p-4 text-sm">
        <p className={cn(!description && "text-muted-foreground")}>
          {description || "No description."}
        </p>
        <ul className="space-y-1.5 text-muted-foreground">
          <li>
            <Link to={links.tasks()} className="flex items-center gap-2 hover:text-foreground">
              <GitPullRequestArrow className="size-4" /> {openTasks} open task{openTasks === 1 ? "" : "s"}
            </Link>
          </li>
          <li>
            <Link to={links.branches()} className="flex items-center gap-2 hover:text-foreground">
              <GitBranch className="size-4" /> {branchCount} branch{branchCount === 1 ? "" : "es"}
            </Link>
          </li>
          <li>
            <Link to={links.tags()} className="flex items-center gap-2 hover:text-foreground">
              <Tag className="size-4" /> {tagCount} tag{tagCount === 1 ? "" : "s"}
            </Link>
          </li>
          <li>
            <Link to={links.commits()} className="flex items-center gap-2 hover:text-foreground">
              <History className="size-4" /> History
            </Link>
          </li>
        </ul>
      </div>
      <LanguagesPanel repo={repo} refName={refName} />
    </Panel>
  );
}

export function RepoPage() {
  const { repo = "", "*": rest = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const repository = useRepository(repo);
  const refs = useRefs(repo);
  const view = parseView(rest);

  const defaultRef = refs.data?.refs.defaultBranch
    ?? repository.data?.repository.defaultBranch
    ?? "main";
  const refName = searchParams.get("ref") ?? defaultRef;
  const links = repoLinks(repo, refName, defaultRef);

  if (repository.isPending) return <Loading className="min-h-64" />;
  if (repository.isError) {
    return <div className="p-8"><ErrorText error={repository.error} /></div>;
  }
  const info = repository.data.repository;
  const tab = tabFor(view);

  function changeRef(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next === defaultRef) params.delete("ref");
    else params.set("ref", next);
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}`);
  }

  const tabs: Array<[Tab, string, string, typeof FileCode2, number?]> = [
    ["code", "Code", links.tree(""), FileCode2],
    ["tasks", "Tasks", links.tasks(), GitPullRequestArrow, info.openTasks],
    ["commits", "Commits", links.commits(), History],
    ["branches", "Branches", links.branches(), GitBranch],
    ["tags", "Tags", links.tags(), Tag],
    ["settings", "Settings", links.settings(), Settings],
  ];
  const browsing = view.kind === "tree" || view.kind === "blob" || view.kind === "commits";

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold tracking-[-0.02em]">
            <Link to="/git" className="text-muted-foreground hover:text-foreground">Git</Link>
            <span className="text-muted-foreground">/</span>
            <Link to={links.home()} className="truncate font-mono">{info.name}</Link>
          </h1>
          {info.description && (
            <p className="mt-1 text-sm text-muted-foreground">{info.description}</p>
          )}
        </div>
        <CloneMenu remote={info.remote} />
      </div>

      <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0" aria-label="Repository">
        {tabs.map(([id, label, to, Icon, count]) => (
          <Link
            key={id}
            to={to}
            aria-current={tab === id ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium",
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
            {count ? <Badge variant="secondary" className="ml-0.5">{count}</Badge> : null}
          </Link>
        ))}
      </nav>

      {browsing && (
        <div className="flex flex-wrap items-center gap-2">
          <RefPicker repo={repo} refName={refName} onChange={changeRef} />
          {(view.kind === "tree" || view.kind === "blob") && view.path && (
            <Breadcrumbs repo={info.name} path={view.path} links={links} />
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link to={links.compare(defaultRef, refName === defaultRef ? "" : refName)} />}>
              <GitCompareArrows /> <span className="hidden sm:inline">Compare</span>
            </Button>
            <FileFinder repo={repo} refName={refName} links={links} />
          </div>
        </div>
      )}

      <Suspense fallback={<Loading />}>
        {(view.kind === "blob" || (view.kind === "tree" && view.path)) && (
          <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <aside className="hidden lg:block">
              <div className="sticky top-4">
                <RepoFileTree
                  repo={repo}
                  refName={refName}
                  path={view.path}
                  kind={view.kind}
                  links={links}
                />
              </div>
            </aside>
            <div className="min-w-0">
              {view.kind === "blob" ? (
                <BlobView repo={repo} refName={refName} path={view.path} links={links} />
              ) : (
                <TreeView repo={repo} refName={refName} path={view.path} links={links} remote={info.remote} />
              )}
            </div>
          </div>
        )}
        {view.kind === "tree" && !view.path && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0">
              <TreeView repo={repo} refName={refName} path="" links={links} remote={info.remote} />
            </div>
            <aside>
              <AboutPanel
                repo={repo}
                refName={refName}
                description={info.description}
                links={links}
                branchCount={refs.data?.refs.branches.length ?? 0}
                tagCount={refs.data?.refs.tags.length ?? 0}
                openTasks={info.openTasks}
              />
            </aside>
          </div>
        )}
        {view.kind === "commits" && (
          <CommitsView repo={repo} refName={refName} path={view.path} links={links} />
        )}
        {view.kind === "commit" && <CommitView repo={repo} hash={view.hash} links={links} />}
        {view.kind === "branches" && <BranchesView repo={repo} links={links} />}
        {view.kind === "tags" && <TagsView repo={repo} links={links} />}
        {view.kind === "compare" && (
          <CompareView repo={repo} spec={view.spec} defaultBranch={defaultRef} links={links} />
        )}
        {view.kind === "settings" && (
          <SettingsView
            key={JSON.stringify(repository.data.branchProtections)}
            repo={repo}
            description={info.description}
            rules={repository.data.branchProtections}
          />
        )}
        {view.kind === "tasks" && <TaskList repo={repo} links={links} />}
        {view.kind === "new-task" && (
          <NewTaskView repo={repo} links={links} defaultBranch={defaultRef} />
        )}
        {view.kind === "task" && (
          <TaskPage
            key={view.number}
            repo={repo}
            number={view.number}
            tab={view.tab}
            links={links}
            remote={info.remote}
          />
        )}
      </Suspense>
    </div>
  );
}
