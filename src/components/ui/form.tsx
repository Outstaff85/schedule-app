// shadcn/ui Form: React Hook Form + Zod. A field is its label, its control and
// one error line; error texts go through tr() (the schema keeps them English).
// Short fields share a line in a FieldRow (CLAUDE.md → Short fields in pairs).
import * as React from 'react';
import { Label as LabelPrimitive, Slot } from 'radix-ui';
import { Controller, FormProvider, useFormContext, useFormState, type ControllerProps, type FieldPath, type FieldValues } from 'react-hook-form';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Label } from '@/components/ui/label';

const Form = FormProvider;

type FormFieldContextValue = { name: string };
const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

function FormField<TFieldValues extends FieldValues = FieldValues, TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

const FormItemContext = React.createContext<{ id: string }>({} as { id: string });

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: fieldContext.name });
  const fieldState = getFieldState(fieldContext.name, formState);
  const { id } = itemContext;
  return { id, name: fieldContext.name, formItemId: `${id}-form-item`, formMessageId: `${id}-form-item-message`, ...fieldState };
}

function FormItem({ className, ...props }: React.ComponentProps<'div'>) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div data-slot="form-item" className={cn('grid min-w-0 gap-1.5', className)} {...props} />
    </FormItemContext.Provider>
  );
}

function FormLabel({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const { error, formItemId } = useFormField();
  return <Label data-slot="form-label" data-error={!!error} className={cn('data-[error=true]:text-[var(--red-text)]', className)} htmlFor={formItemId} {...props} />;
}

function FormControl(props: React.ComponentProps<typeof Slot.Root>) {
  const { error, formItemId, formMessageId } = useFormField();
  return <Slot.Root data-slot="form-control" id={formItemId} aria-describedby={error ? formMessageId : undefined} aria-invalid={!!error} {...props} />;
}

function FormDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="form-description" className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

function FormMessage({ className, ...props }: React.ComponentProps<'p'>) {
  const { error, formMessageId } = useFormField();
  const body = error ? tr(String(error.message ?? '')) : props.children;
  if (!body) return null;
  return <p data-slot="form-message" id={formMessageId} className={cn('text-xs text-[var(--red-text)]', className)} {...props}>{body}</p>;
}

/** Two short fields on one line, on a phone and a computer. */
function FieldRow({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field-row" className={cn('grid grid-cols-2 gap-2.5 [&>*]:min-w-0', className)} {...props} />;
}

/** A heading that splits a long form (the old pages' .form-section). */
function FormSection({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="form-section" className={cn('og-label mt-2 border-b border-border pb-1.5', className)} {...props} />;
}

export { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage, FieldRow, FormSection, useFormField };
