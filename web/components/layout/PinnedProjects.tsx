import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router';
import { EntityIcon } from '@web/components/common/EntityIcon';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@web/components/ui/sidebar';
import { useMe } from '@web/lib/auth';
import { cn } from '@web/lib/utils';
import { ProjectContextMenu } from './SidebarMenus';
import {
  movePinned,
  pinnedProjects,
  useReorderPinnedProjects,
  type PinnedProject,
} from './sidebarTeams';

/**
 * The Pinned section at the top of the sidebar: your pinned projects, in your order, each labelled
 * with its team. They stay listed under their team too (with a pin mark), so the team lists stay
 * complete. Drag an entry to reorder, or use its right-click menu (Unpin, Move up, Move down).
 */
export function PinnedProjects({ pathname }: { pathname: string }) {
  const me = useMe().data;
  const entries = pinnedProjects(me);
  const reorder = useReorderPinnedProjects();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  if (entries.length === 0) return null;
  const ids = entries.map((entry) => entry.project.id);
  const move = (activeId: string, overId: string) => {
    const next = movePinned(ids, activeId, overId);
    if (next) reorder.mutate(next);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    swallowClick();
    if (over) move(String(active.id), String(over.id));
  };
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu aria-label="Pinned projects">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            onDragCancel={swallowClick}
            accessibility={{ container: document.body }}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {entries.map((entry, index) => (
                <PinnedEntry
                  key={entry.project.id}
                  entry={entry}
                  pathname={pathname}
                  draggable={entries.length > 1}
                  onMoveUp={
                    index > 0 ? () => move(entry.project.id, ids[index - 1] ?? '') : undefined
                  }
                  onMoveDown={
                    index < ids.length - 1
                      ? () => move(entry.project.id, ids[index + 1] ?? '')
                      : undefined
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function PinnedEntry({
  entry: { team, project },
  pathname,
  draggable,
  onMoveUp,
  onMoveDown,
}: {
  entry: PinnedProject;
  pathname: string;
  draggable: boolean;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
}) {
  const { setOpenMobile } = useSidebar();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: project.id, disabled: !draggable });
  const to = `/t/${team.slug}/p/${project.key}`;
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'z-10 rounded-md bg-sidebar shadow-md ring-1 ring-border')}
    >
      <ProjectContextMenu team={team} project={project} onMoveUp={onMoveUp} onMoveDown={onMoveDown}>
        <SidebarMenuButton
          asChild
          isActive={pathname === to}
          tooltip={`${project.name} · ${team.name}`}
        >
          <Link
            ref={setActivatorNodeRef}
            {...listeners}
            to={to}
            onClick={() => setOpenMobile(false)}
            aria-current={pathname === to ? 'page' : undefined}
          >
            <EntityIcon icon={project.icon} name={project.name} color={project.color} />
            <span className={cn('truncate', active && 'font-medium')}>{project.name}</span>
            <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
              <span className="sr-only">in </span>
              {team.name}
            </span>
          </Link>
        </SidebarMenuButton>
      </ProjectContextMenu>
    </SidebarMenuItem>
  );
}

/** See AppSidebar: the click that ends a drag must not follow the dropped link. */
function swallowClick() {
  const prevent = (event: MouseEvent) => event.preventDefault();
  window.addEventListener('click', prevent, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', prevent, { capture: true }), 300);
}
