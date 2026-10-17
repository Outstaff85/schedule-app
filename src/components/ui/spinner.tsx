import * as React from 'react';
import { IconLoader2 } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return <IconLoader2 role="status" aria-label={tr('Loading')} className={cn('size-4 animate-spin', className)} {...props} />;
}

export { Spinner };
