import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide transition-colors', {
  variants: { variant: {
    default: 'border-transparent bg-primary text-primary-foreground',
    secondary: 'border-transparent bg-secondary text-secondary-foreground',
    outline: 'text-muted-foreground',
    destructive: 'border-transparent bg-destructive/15 text-destructive',
  } }, defaultVariants: { variant: 'default' },
});
export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) { return <div className={cn(badgeVariants({ variant }), className)} {...props} />; }

/**
 * A badge that opens something. Used for reference surfaces that read as labels rather than actions,
 * so they can sit in a status row instead of consuming header width.
 */
export const inlineTrigger = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
