// shadcn/ui Sonner: the toasts. Message toasts are menu glass at the bottom.
// The Undo snack after a delete is shared/undo.tsx (undoToast), drawn with
// og.css's .og-snack look through sonner's custom toast.
import { Toaster as Sonner, type ToasterProps } from 'sonner';

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-center"
      offset={16}
      mobileOffset={16}
      toastOptions={{
        classNames: {
          toast: '!og-glass-menu !text-sm !font-medium !gap-2.5 !py-3 !pl-4 !pr-3',
          description: '!text-[var(--ink-on-glass)]',
          success: '[&_[data-icon]]:!text-ok',
          error: '[&_[data-icon]]:!text-bad',
          warning: '[&_[data-icon]]:!text-warn',
          info: '[&_[data-icon]]:!text-info',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
