import { useMutation } from "@tanstack/react-query";

type LabeledOperation = { label: string; run: () => Promise<unknown> };

export function useLabeledOperation(options: {
  onSuccess: (label: string) => unknown;
  onError: (error: Error) => unknown;
}) {
  const mutation = useMutation({
    mutationFn: async (operation: LabeledOperation) => operation.run(),
    onSuccess: (_result, operation) => options.onSuccess(operation.label),
    onError: options.onError,
  });
  return {
    run: (label: string, run: () => Promise<unknown>) =>
      mutation.mutate({ label, run }),
    pending: mutation.isPending,
    pendingLabel: mutation.isPending ? mutation.variables.label : null,
  };
}
