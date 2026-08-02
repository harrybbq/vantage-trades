import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  kicker: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

export function Modal({ kicker, title, onClose, children, footer }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        // mousedown, not click: a drag that starts inside the modal and ends
        // on the scrim should not dismiss a confirmation.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={panel}>
        <div className="modal-head">
          <span className="label">{kicker}</span>
          <h2 id="modal-title">{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}
