import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import type { ReactNode } from 'react';
import {
  SuggestionMenu,
  type SuggestionItem,
  type SuggestionMenuHandle,
  type SuggestionMenuProps,
} from './SuggestionMenu';

/** Builds the `render` option of a Tiptap suggestion around `SuggestionMenu`. */
export function suggestionRenderer<I extends SuggestionItem>(options: {
  renderItem: (item: I) => ReactNode;
  emptyText: string;
  label: string;
}): NonNullable<SuggestionOptions<I, I>['render']> {
  return () => {
    let renderer: ReactRenderer<SuggestionMenuHandle, SuggestionMenuProps<I>> | null = null;
    let unmount: (() => void) | null = null;

    const toProps = (props: SuggestionProps<I, I>): SuggestionMenuProps<I> => ({
      items: props.items,
      loading: props.loading,
      command: props.command,
      renderItem: options.renderItem,
      emptyText: options.emptyText,
      label: options.label,
    });

    return {
      onStart: (props) => {
        renderer = new ReactRenderer(SuggestionMenu<I>, {
          props: toProps(props),
          editor: props.editor,
        });
        unmount = props.mount(renderer.element);
      },
      onUpdate: (props) => renderer?.updateProps(toProps(props)),
      onKeyDown: (props) => {
        if (props.event.key === 'Escape') return false;
        return renderer?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        unmount?.();
        renderer?.destroy();
        renderer = null;
        unmount = null;
      },
    };
  };
}
