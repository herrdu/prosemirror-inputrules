import { Plugin, EditorState, Transaction, TextSelection } from "prosemirror-state";
import { Schema } from "prosemirror-model";
import { EditorView } from "prosemirror-view";

type InputRuleHandler<S extends Schema = any> = (
  state: EditorState<S>,
  match: string[],
  start: number,
  end: number
) => Transaction<S> | null;

// ::- Input rules are regular expressions describing a piece of text
// that, when typed, causes something to happen. This might be
// changing two dashes into an emdash, wrapping a paragraph starting
// with `"> "` into a blockquote, or something entirely different.
export class InputRule<S extends Schema = any> {
  match: RegExp;
  handler: string | InputRuleHandler;

  // :: (RegExp, union<string, (state: EditorState, match: [string], start: number, end: number) → ?Transaction>)
  // Create an input rule. The rule applies when the user typed
  // something and the text directly in front of the cursor matches
  // `match`, which should probably end with `$`.
  //
  // The `handler` can be a string, in which case the matched text, or
  // the first matched group in the regexp, is replaced by that
  // string.
  //
  // Or a it can be a function, which will be called with the match
  // array produced by
  // [`RegExp.exec`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/exec),
  // as well as the start and end of the matched range, and which can
  // return a [transaction](#state.Transaction) that describes the
  // rule's effect, or null to indicate the input was not handled.
  constructor(
    match: RegExp,
    handler: string | ((state: EditorState<S>, match: string[], start: number, end: number) => Transaction<S> | null)
  ) {
    this.match = match;
    this.handler = typeof handler == "string" ? stringHandler(handler) : handler;
  }
}

function stringHandler(string: string) {
  return function (state: EditorState, match: string[], start: number, end: number) {
    let insert = string;
    if (match[1]) {
      let offset = match[0].lastIndexOf(match[1]);
      insert += match[0].slice(offset + match[1].length);
      start += offset;
      let cutOff = start - end;
      if (cutOff > 0) {
        insert = match[0].slice(offset - cutOff, offset) + insert;
        start = end;
      }
    }
    return state.tr.insertText(insert, start, end);
  };
}

const MAX_MATCH = 500;

// :: (config: {rules: [InputRule]}) → Plugin
// Create an input rules plugin. When enabled, it will cause text
// input that matches any of the given rules to trigger the rule's
// action.
export function inputRules({ rules }) {
  let plugin = new Plugin({
    state: {
      init() {
        return null;
      },
      apply(tr, prev) {
        let stored = tr.getMeta(this);
        if (stored) return stored;
        return tr.selectionSet || tr.docChanged ? null : prev;
      },
    },

    props: {
      handleTextInput(view, from, to, text) {
        return run(view, from, to, text, rules, plugin);
      },
      handleDOMEvents: {
        compositionend: (view) => {
          setTimeout(() => {
            let { $cursor } = view.state.selection as TextSelection;
            if ($cursor) run(view, $cursor.pos, $cursor.pos, "", rules, plugin);
          });
          return true;
        },
      },
    },
    // @ts-ignore
    isInputRules: true,
  });
  return plugin;
}

function run(view: EditorView, from: number, to: number, text: string, rules: InputRule[], plugin: Plugin) {
  if (view.composing) return false;
  let state = view.state,
    $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  let textBefore =
    $from.parent.textBetween(Math.max(0, $from.parentOffset - MAX_MATCH), $from.parentOffset, null, "\ufffc") + text;
  for (let i = 0; i < rules.length; i++) {
    let match = rules[i].match.exec(textBefore);
    let tr = match && (rules[i].handler as InputRuleHandler)(state, match, from - (match[0].length - text.length), to);
    if (!tr) continue;
    view.dispatch(tr.setMeta(plugin, { transform: tr, from, to, text }));
    return true;
  }
  return false;
}

// :: (EditorState, ?(Transaction)) → bool
// This is a command that will undo an input rule, if applying such a
// rule was the last thing that the user did.
export function undoInputRule(state: EditorState, dispatch?: (tr: Transaction) => boolean) {
  let plugins = state.plugins;
  for (let i = 0; i < plugins.length; i++) {
    let plugin = plugins[i],
      undoable: any;
    if ((plugin.spec as any).isInputRules && (undoable = plugin.getState(state))) {
      if (dispatch) {
        let tr = state.tr,
          toUndo = undoable.transform;
        for (let j = toUndo.steps.length - 1; j >= 0; j--) tr.step(toUndo.steps[j].invert(toUndo.docs[j]));
        let marks = tr.doc.resolve(undoable.from).marks();
        dispatch(tr.replaceWith(undoable.from, undoable.to, state.schema.text(undoable.text, marks)));
      }
      return true;
    }
  }
  return false;
}
