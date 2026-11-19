'use client';

import { useApi } from '@/lib/hooks';
import type { HookLibraryDto } from '@/lib/types';
import { IconBrand, PageHeader } from '@/ui';
import { HookLibraryPanel } from '@/components/hook-library-panel';

/** Phase 7 - the hook library: which openings actually worked for this account. */
export default function HooksPage() {
  const { data, error, loading } = useApi<HookLibraryDto>('/content/hooks');

  return (
    <div className="space-y-4 lg:space-y-5">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <IconBrand className="h-3.5 w-3.5" aria-hidden /> Phase 7
          </span>
        }
        title="Hook library"
        subtitle="What actually worked, measured from published and rejected posts"
      />
      <HookLibraryPanel data={data} loading={loading} error={error} />
    </div>
  );
}
