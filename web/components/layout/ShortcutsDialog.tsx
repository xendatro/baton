import { Kbd } from '@web/components/common/Kbd';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import {
  setShortcutsHelpOpen,
  useRegisteredHotkeys,
  useShortcutsHelpOpen,
  type RegisteredHotkey,
} from '@web/lib/hotkeys';

/** Groups in display order; any other group is listed after these. */
const GROUP_ORDER = ['General', 'Navigation', 'Project', 'Task', 'Editor'];

function groupHotkeys(hotkeys: readonly RegisteredHotkey[]): Array<[string, RegisteredHotkey[]]> {
  const groups = new Map<string, RegisteredHotkey[]>();
  for (const hotkey of hotkeys) {
    groups.set(hotkey.group, [...(groups.get(hotkey.group) ?? []), hotkey]);
  }
  const rank = (group: string) => {
    const index = GROUP_ORDER.indexOf(group);
    return index < 0 ? GROUP_ORDER.length : index;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/** The `?` dialog: every shortcut that works on the current page. */
export function ShortcutsDialog() {
  const open = useShortcutsHelpOpen();
  const hotkeys = useRegisteredHotkeys();
  const groups = groupHotkeys([
    ...hotkeys,
    { keys: 'mod+enter', description: 'Submit the editor', group: 'Editor' },
    { keys: 'escape', description: 'Close dialogs and menus', group: 'General' },
  ]);
  return (
    <Dialog open={open} onOpenChange={setShortcutsHelpOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts don’t fire while you type in a field or the editor.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {groups.map(([group, items]) => (
            <section key={group} aria-labelledby={`shortcuts-${group}`}>
              <h3
                id={`shortcuts-${group}`}
                className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {group}
              </h3>
              <dl className="divide-y rounded-md border">
                {items.map((item) => (
                  <div
                    key={`${item.keys}-${item.description}`}
                    className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                  >
                    <dt>{item.description}</dt>
                    <dd>
                      <Kbd keys={item.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
