'use client';
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) { return <SelectPrimitive.Trigger className={cn('flex h-9 items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-xs outline-none focus:ring-2 focus:ring-ring', className)} {...props}>{children}<SelectPrimitive.Icon><ChevronDown className="size-3.5 text-muted-foreground"/></SelectPrimitive.Icon></SelectPrimitive.Trigger>; }
export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) { return <SelectPrimitive.Portal><SelectPrimitive.Content className={cn('z-[60] min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 shadow-xl', className)} position="popper" {...props}><SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport></SelectPrimitive.Content></SelectPrimitive.Portal>; }
export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) { return <SelectPrimitive.Item className={cn('relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-xs outline-none focus:bg-secondary', className)} {...props}><span className="absolute left-2"><SelectPrimitive.ItemIndicator><Check className="size-3.5"/></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>; }
