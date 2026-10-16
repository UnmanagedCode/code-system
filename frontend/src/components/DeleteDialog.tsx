import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Asks before a delete: a loss of data asks first. `remoteId` null means closed. */
export function DeleteDialog({ remoteId, onCancel, onConfirm }: {
  remoteId: string | null;
  onCancel: () => void;
  onConfirm: (remoteId: string) => void;
}) {
  // The title keeps the last id while the dialog animates closed.
  const shown = useRef(remoteId);
  if (remoteId !== null) shown.current = remoteId;
  return (
    <Dialog open={remoteId !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="break-all">Delete remote '{shown.current}'?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => { if (remoteId !== null) onConfirm(remoteId); }}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
