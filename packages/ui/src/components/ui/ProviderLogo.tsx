import React from 'react';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const [loaded, setLoaded] = React.useState(false);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (!hasLogo || !src) {
        return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={cn('size-5 object-contain text-muted-foreground', className)}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></svg>;
    }

    return (
        <img
            src={src}
            alt={alt ?? `${providerId} logo`}
            className={cn('dark:invert object-contain', !loaded && 'opacity-0', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            onLoad={() => setLoaded(true)}
            draggable={false}
            onError={handleError}
        />
    );
};
