import { Component, type ReactNode } from 'react';

/**
 * Contains a card's render failure to that card. A record is whatever its file says, so one the UI
 * cannot draw must cost one card, never the page: the boundary renders `fallback` instead, and tries
 * the card again whenever `resetKey` changes (the record or the open form moved).
 */
export class CardBoundary extends Component<
  { resetKey: string; fallback: (message: string) => ReactNode; children: ReactNode },
  { error: string | null; key: string }
> {
  state = { error: null as string | null, key: this.props.resetKey };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { key: string }) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  render() {
    return this.state.error === null ? this.props.children : this.props.fallback(this.state.error);
  }
}
