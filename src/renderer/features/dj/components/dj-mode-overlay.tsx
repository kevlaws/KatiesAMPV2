import { useQuery } from '@tanstack/react-query';
import { useWavesurfer } from '@wavesurfer/react';
import formatDuration from 'format-duration';
import {
    DragEvent,
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import styles from './dj-mode-overlay.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { getSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { sharedQueries } from '/@/renderer/features/shared/api/shared-api';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useCurrentServer, usePlaybackSettings, useSetDjModeExpanded } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Icon } from '/@/shared/components/icon/icon';
import { Select } from '/@/shared/components/select/select';
import { TextInput } from '/@/shared/components/text-input/text-input';
import {
    LibraryItem,
    QueueSong,
    Song,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

type DeckGraph = {
    context: AudioContext;
    high: BiquadFilterNode;
    input: GainNode;
    limiter: DynamicsCompressorNode;
    low: BiquadFilterNode;
    mid: BiquadFilterNode;
    output: GainNode;
};

type DeckId = 'A' | 'B';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const equalPowerMix = (crossfader: number) => {
    const position = (clamp(crossfader, -1, 1) + 1) / 2;
    return {
        a: Math.cos(position * (Math.PI / 2)),
        b: Math.sin(position * (Math.PI / 2)),
    };
};

const formatTime = (seconds: number) =>
    formatDuration(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);

const toQueueSong = (song: Song, deck: DeckId): QueueSong => ({
    ...song,
    _uniqueId: `dj-${deck}-${song.id}`,
});

const Deck = ({
    deck,
    master,
    mix,
    onDropSong,
    onEject,
    song,
}: {
    deck: DeckId;
    master: number;
    mix: number;
    onDropSong: () => void;
    onEject: () => void;
    song?: Song;
}) => {
    const { transcode } = usePlaybackSettings();
    const audioRef = useRef<HTMLAudioElement>(document.createElement('audio'));
    const graphRef = useRef<DeckGraph | undefined>(undefined);
    const waveformRef = useRef<HTMLDivElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [deckGain, setDeckGain] = useState(1);
    const [duration, setDuration] = useState(0);
    const [eq, setEq] = useState({ high: 0, low: 0, mid: 0 });
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);

    const accent = deck === 'A' ? '#71d8bd' : '#e7b36a';
    const { wavesurfer } = useWavesurfer({
        barGap: 2,
        barRadius: 2,
        barWidth: 2,
        container: waveformRef,
        cursorColor: '#ffffff',
        cursorWidth: 1,
        height: 74,
        interact: true,
        media: audioRef.current,
        normalize: true,
        progressColor: accent,
        waveColor: 'rgba(255, 255, 255, 0.22)',
    });

    useEffect(() => {
        const audio = audioRef.current;
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';

        const context = new AudioContext({ latencyHint: 'interactive' });
        const source = context.createMediaElementSource(audio);
        const input = context.createGain();
        const low = context.createBiquadFilter();
        const mid = context.createBiquadFilter();
        const high = context.createBiquadFilter();
        const limiter = context.createDynamicsCompressor();
        const output = context.createGain();

        low.type = 'lowshelf';
        low.frequency.value = 250;
        mid.type = 'peaking';
        mid.frequency.value = 1_000;
        mid.Q.value = 1;
        high.type = 'highshelf';
        high.frequency.value = 4_000;
        limiter.threshold.value = -1;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;

        source.connect(input);
        input.connect(low);
        low.connect(mid);
        mid.connect(high);
        high.connect(limiter);
        limiter.connect(output);
        output.connect(context.destination);
        graphRef.current = { context, high, input, limiter, low, mid, output };

        return () => {
            audio.pause();
            audio.removeAttribute('src');
            graphRef.current = undefined;
            void context.close().catch(() => {});
        };
    }, []);

    useEffect(() => {
        const audio = audioRef.current;
        const handleDuration = () =>
            setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
        const handleEnded = () => setIsPlaying(false);
        const handlePause = () => setIsPlaying(false);
        const handlePlay = () => setIsPlaying(true);
        const handleTime = () => setCurrentTime(audio.currentTime || 0);

        audio.addEventListener('durationchange', handleDuration);
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('pause', handlePause);
        audio.addEventListener('play', handlePlay);
        audio.addEventListener('timeupdate', handleTime);

        return () => {
            audio.removeEventListener('durationchange', handleDuration);
            audio.removeEventListener('ended', handleEnded);
            audio.removeEventListener('pause', handlePause);
            audio.removeEventListener('play', handlePlay);
            audio.removeEventListener('timeupdate', handleTime);
        };
    }, []);

    useEffect(() => {
        const graph = graphRef.current;
        if (!graph) return;
        const now = graph.context.currentTime;
        graph.input.gain.setTargetAtTime(deckGain, now, 0.01);
        graph.low.gain.setTargetAtTime(eq.low, now, 0.01);
        graph.mid.gain.setTargetAtTime(eq.mid, now, 0.01);
        graph.high.gain.setTargetAtTime(eq.high, now, 0.01);
        graph.output.gain.setTargetAtTime(clamp(mix * master, 0, 1), now, 0.01);
    }, [deckGain, eq, master, mix]);

    useEffect(() => {
        if (!wavesurfer) return;

        const audio = audioRef.current;
        audio.pause();
        setCurrentTime(0);
        setDuration(0);
        setError('');

        if (!song) {
            setIsLoading(false);
            wavesurfer.empty();
            return;
        }

        let cancelled = false;
        setIsLoading(true);

        void getSongUrl(
            toQueueSong(song, deck),
            {
                bitrate: transcode.bitrate,
                enabled: transcode.enabled,
                format: transcode.format,
                maxSampleRate: transcode.maxSampleRate,
            },
            false,
            true,
        )
            .then(async (url) => {
                if (cancelled) return;
                await wavesurfer.load(url);
            })
            .catch((loadError) => {
                if (cancelled || (loadError instanceof Error && loadError.name === 'AbortError')) {
                    return;
                }
                setError('Unable to load this track');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [deck, song, transcode, wavesurfer]);

    const togglePlayback = async () => {
        if (!song || isLoading || error) return;
        const audio = audioRef.current;
        const context = graphRef.current?.context;

        if (audio.paused) {
            if (context?.state === 'suspended') await context.resume();
            await audio.play().catch(() => setError('Playback could not start'));
        } else {
            audio.pause();
        }
    };

    const cue = () => {
        const audio = audioRef.current;
        audio.pause();
        audio.currentTime = 0;
        setCurrentTime(0);
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        onDropSong();
    };

    return (
        <>
            <section
                aria-label={`Deck ${deck}`}
                className={styles.deck}
                data-deck={deck.toLowerCase()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
            >
                <header className={styles.deckHeader}>
                    <div className={styles.deckIdentity}>
                        <span className={styles.deckBadge}>Deck {deck}</span>
                        <Button
                            aria-label={`Eject Deck ${deck}`}
                            disabled={!song}
                            onClick={onEject}
                            size="compact-xs"
                            variant="subtle"
                        >
                            Eject
                        </Button>
                    </div>
                    <div className={styles.deckHeaderActions}>
                        <span className={styles.deckState}>
                            {error ||
                                (!song
                                    ? 'Not ready'
                                    : isLoading
                                      ? 'Loading…'
                                      : isPlaying
                                        ? 'Playing'
                                        : 'Ready')}
                        </span>
                        <div className={styles.transport}>
                            <Button disabled={!song} onClick={cue} size="sm" variant="default">
                                Cue
                            </Button>
                            <Button
                                disabled={!song || isLoading || Boolean(error)}
                                onClick={() => void togglePlayback()}
                                size="sm"
                                variant="filled"
                            >
                                {isPlaying ? 'Pause' : 'Play'}
                            </Button>
                        </div>
                    </div>
                </header>

                <div className={styles.deckMain}>
                    <div className={styles.deckTrack}>
                        <div className={styles.artwork}>
                            {song ? (
                                <ItemImage
                                    alt=""
                                    id={song.id}
                                    itemType={LibraryItem.SONG}
                                    serverId={song._serverId}
                                    src={song.imageUrl}
                                    type="itemCard"
                                />
                            ) : (
                                <Icon icon="disc" size="3xl" />
                            )}
                        </div>
                        <div className={styles.trackCopy}>
                            <strong>{song?.name || `Drop a track onto Deck ${deck}`}</strong>
                            <span>{song?.artistName || 'No track loaded'}</span>
                            <span>{song?.album || ' '}</span>
                        </div>
                    </div>

                    <div className={styles.timeRow}>
                        <span>{formatTime(currentTime)}</span>
                        <input
                            aria-label={`Deck ${deck} position`}
                            disabled={!duration}
                            max={duration || 1}
                            min={0}
                            onChange={(event) => {
                                audioRef.current.currentTime = Number(event.currentTarget.value);
                            }}
                            step={0.1}
                            type="range"
                            value={Math.min(currentTime, duration || 0)}
                        />
                        <span>{formatTime(duration)}</span>
                    </div>
                    <div
                        aria-label={`Deck ${deck} waveform`}
                        className={styles.waveform}
                        ref={waveformRef}
                    />
                </div>
            </section>
            <aside
                aria-label={`Deck ${deck} controls`}
                className={styles.deckMixer}
                data-deck={deck.toLowerCase()}
            >
                <span className={styles.mixerDeckLabel}>{deck}</span>
                <div className={styles.deckMixerControls}>
                    <RotaryDial
                        ariaLabel={`Deck ${deck} Gain`}
                        label="Gain"
                        max={1.25}
                        min={0}
                        onChange={setDeckGain}
                        resetValue={1}
                        step={0.01}
                        value={deckGain}
                        valueLabel={`${Math.round(deckGain * 100)}%`}
                    />
                    <RotaryDial
                        ariaLabel={`Deck ${deck} Treble`}
                        label="Treble"
                        max={12}
                        min={-12}
                        onChange={(high) => setEq((current) => ({ ...current, high }))}
                        resetValue={0}
                        step={1}
                        value={eq.high}
                        valueLabel={`${eq.high} dB`}
                    />
                    <RotaryDial
                        ariaLabel={`Deck ${deck} Mid`}
                        label="Mid"
                        max={12}
                        min={-12}
                        onChange={(mid) => setEq((current) => ({ ...current, mid }))}
                        resetValue={0}
                        step={1}
                        value={eq.mid}
                        valueLabel={`${eq.mid} dB`}
                    />
                    <RotaryDial
                        ariaLabel={`Deck ${deck} Bass`}
                        label="Bass"
                        max={12}
                        min={-12}
                        onChange={(low) => setEq((current) => ({ ...current, low }))}
                        resetValue={0}
                        step={1}
                        value={eq.low}
                        valueLabel={`${eq.low} dB`}
                    />
                </div>
            </aside>
        </>
    );
};

const RotaryDial = ({
    ariaLabel,
    label,
    max,
    min,
    onChange,
    resetValue,
    step,
    value,
    valueLabel,
}: {
    ariaLabel: string;
    label: string;
    max: number;
    min: number;
    onChange: (value: number) => void;
    resetValue: number;
    step: number;
    value: number;
    valueLabel: string;
}) => {
    const drag = useRef<undefined | { startValue: number; startY: number }>(undefined);
    const angle = -135 + ((value - min) / (max - min)) * 270;
    const updateValue = (nextValue: number) => {
        const steppedValue = min + Math.round((nextValue - min) / step) * step;
        onChange(clamp(steppedValue, min, max));
    };

    return (
        <label className={styles.rotaryDial}>
            <span>{label}</span>
            <span className={styles.dialControl}>
                <span aria-hidden className={styles.dialKnob}>
                    <span
                        className={styles.dialIndicator}
                        style={{ transform: `rotate(${angle}deg)` }}
                    />
                </span>
                <input
                    aria-label={ariaLabel}
                    aria-valuetext={valueLabel}
                    max={max}
                    min={min}
                    onChange={(event) => updateValue(Number(event.currentTarget.value))}
                    onDoubleClick={() => onChange(resetValue)}
                    onPointerCancel={() => {
                        drag.current = undefined;
                    }}
                    onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        drag.current = { startValue: value, startY: event.clientY };
                    }}
                    onPointerMove={(event) => {
                        if (!drag.current) return;
                        const movement = (drag.current.startY - event.clientY) / 80;
                        updateValue(drag.current.startValue + movement * (max - min));
                    }}
                    onPointerUp={(event) => {
                        drag.current = undefined;
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                    onWheel={(event) => {
                        event.preventDefault();
                        updateValue(value + (event.deltaY < 0 ? step : -step));
                    }}
                    step={step}
                    title="Drag vertically, use the mouse wheel or arrow keys. Double-click to reset."
                    type="range"
                    value={value}
                />
            </span>
            <output>{valueLabel}</output>
        </label>
    );
};

export const DjModeOverlay = () => {
    const closeDjMode = useSetDjModeExpanded();
    const currentServer = useCurrentServer();
    const [crossfader, setCrossfader] = useState(0);
    const [deckA, setDeckA] = useState<Song>();
    const [deckB, setDeckB] = useState<Song>();
    const [djMusicFolderId, setDjMusicFolderId] = useState(currentServer?.musicFolderId?.[0]);
    const [draggedSong, setDraggedSong] = useState<Song>();
    const [master, setMaster] = useState(0.8);
    const [prepared, setPrepared] = useState<Song[]>([]);
    const [search, setSearch] = useState('');
    const deferredSearch = useDeferredValue(search.trim());
    const mix = useMemo(() => equalPowerMix(crossfader), [crossfader]);
    const musicFoldersQuery = useQuery(
        currentServer
            ? sharedQueries.musicFolders({ query: null, serverId: currentServer.id })
            : { enabled: false, queryKey: ['disabled', 'dj-music-folders'] },
    );
    const musicFolders = musicFoldersQuery.data;

    useEffect(() => {
        if (!musicFolders) return;

        setDjMusicFolderId((current) => {
            if (current && musicFolders.items.some((folder) => folder.id === current)) {
                return current;
            }

            return (
                currentServer?.musicFolderId?.find((id) =>
                    musicFolders.items.some((folder) => folder.id === id),
                ) || musicFolders.items[0]?.id
            );
        });
    }, [currentServer?.musicFolderId, musicFolders]);

    const songsQuery = useQuery(
        songsQueries.list({
            options: { enabled: Boolean(currentServer?.id && djMusicFolderId) },
            query: {
                limit: 200,
                musicFolderId: djMusicFolderId,
                searchTerm: deferredSearch || undefined,
                sortBy: SongListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
            serverId: currentServer?.id || '',
        }),
    );
    const songs = songsQuery.data?.items || [];

    const exit = useCallback(() => closeDjMode(false), [closeDjMode]);

    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') exit();
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [exit]);

    const loadDeck = (deck: DeckId, song: Song) => {
        if (deck === 'A') setDeckA(song);
        else setDeckB(song);
    };

    const addPrepared = (song: Song) => {
        setPrepared((current) =>
            current.some((item) => item.id === song.id) ? current : [...current, song],
        );
    };

    const handleDrop = (deck: DeckId) => {
        if (!draggedSong) return;
        loadDeck(deck, draggedSong);
        setDraggedSong(undefined);
    };

    const startDrag = (event: DragEvent, song: Song) => {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', song.id);
        setDraggedSong(song);
    };

    return (
        <div aria-label="KatiesAmp DJ Mode" className={styles.overlay} role="dialog">
            <header className={styles.header}>
                <div>
                    <span className={styles.kicker}>KatiesAmp</span>
                    <h1>DJ Mode</h1>
                </div>
                <div className={styles.headerActions}>
                    <span className={styles.serverName}>{currentServer?.name}</span>
                    <Button onClick={exit} size="compact-sm" variant="default">
                        Exit DJ Mode
                    </Button>
                </div>
            </header>

            <main className={styles.workspace}>
                <div className={styles.decks}>
                    <Deck
                        deck="A"
                        master={master}
                        mix={mix.a}
                        onDropSong={() => handleDrop('A')}
                        onEject={() => setDeckA(undefined)}
                        song={deckA}
                    />
                    <section aria-label="Master mixer" className={styles.masterMixer}>
                        <span className={styles.mixerLabel}>Master</span>
                        <RotaryDial
                            ariaLabel="Master volume"
                            label="Volume"
                            max={1}
                            min={0}
                            onChange={setMaster}
                            resetValue={0.8}
                            step={0.01}
                            value={master}
                            valueLabel={`${Math.round(master * 100)}%`}
                        />
                        <label className={styles.crossfader}>
                            <span>Crossfader</span>
                            <div className={styles.crossfaderLabels}>
                                <b>A</b>
                                <b>B</b>
                            </div>
                            <input
                                aria-label="Crossfader"
                                max={1}
                                min={-1}
                                onChange={(event) =>
                                    setCrossfader(Number(event.currentTarget.value))
                                }
                                step={0.01}
                                type="range"
                                value={crossfader}
                            />
                        </label>
                        <Button onClick={() => setCrossfader(0)} size="compact-xs" variant="subtle">
                            Centre
                        </Button>
                        <label className={styles.musicFolderSelector}>
                            <span>DJ music folder</span>
                            <Select
                                aria-label="Select DJ music folder"
                                data={
                                    musicFolders?.items.map((folder) => ({
                                        label: folder.name,
                                        value: folder.id,
                                    })) || []
                                }
                                disabled={
                                    musicFoldersQuery.isLoading ||
                                    musicFoldersQuery.isError ||
                                    !musicFolders?.items.length
                                }
                                onChange={(value) => {
                                    if (value) setDjMusicFolderId(value);
                                }}
                                placeholder={
                                    musicFoldersQuery.isLoading
                                        ? 'Loading folders…'
                                        : musicFolders?.items.length
                                          ? 'Choose a DJ folder'
                                          : 'Folders unavailable'
                                }
                                value={djMusicFolderId || null}
                                width="100%"
                            />
                        </label>
                    </section>
                    <Deck
                        deck="B"
                        master={master}
                        mix={mix.b}
                        onDropSong={() => handleDrop('B')}
                        onEject={() => setDeckB(undefined)}
                        song={deckB}
                    />
                </div>

                <section className={styles.browser}>
                    <div className={styles.libraryPane}>
                        <div className={styles.browserHeader}>
                            <div>
                                <span className={styles.kicker}>Music library</span>
                                <h2>Tracks</h2>
                            </div>
                            <TextInput
                                aria-label="Search DJ tracks"
                                leftSection={<Icon icon="search" />}
                                onChange={(event) => setSearch(event.currentTarget.value)}
                                placeholder="Search tracks or artists"
                                value={search}
                            />
                        </div>
                        <div className={styles.trackHeader}>
                            <span>Track</span>
                            <span>Album</span>
                            <span>Length</span>
                            <span>Load</span>
                        </div>
                        <div className={styles.trackList}>
                            {songsQuery.isLoading && (
                                <p className={styles.empty}>Loading tracks…</p>
                            )}
                            {songsQuery.isError && (
                                <p className={styles.empty}>
                                    The music library could not be loaded.
                                </p>
                            )}
                            {!songsQuery.isLoading && !songsQuery.isError && songs.length === 0 && (
                                <p className={styles.empty}>No matching tracks.</p>
                            )}
                            {songs.map((song) => (
                                <div
                                    className={styles.trackRow}
                                    draggable
                                    key={song.id}
                                    onDoubleClick={() => loadDeck(deckA ? 'B' : 'A', song)}
                                    onDragEnd={() => setDraggedSong(undefined)}
                                    onDragStart={(event) => startDrag(event, song)}
                                >
                                    <div className={styles.trackIdentity}>
                                        <strong>{song.name}</strong>
                                        <span>{song.artistName}</span>
                                    </div>
                                    <span>{song.album || 'Unknown album'}</span>
                                    <span>{formatTime(song.duration / 1000)}</span>
                                    <div className={styles.rowActions}>
                                        <button
                                            aria-label={`Load ${song.name} to Deck A`}
                                            onClick={() => loadDeck('A', song)}
                                            type="button"
                                        >
                                            A
                                        </button>
                                        <button
                                            aria-label={`Load ${song.name} to Deck B`}
                                            onClick={() => loadDeck('B', song)}
                                            type="button"
                                        >
                                            B
                                        </button>
                                        <button
                                            aria-label={`Add ${song.name} to preparation`}
                                            onClick={() => addPrepared(song)}
                                            type="button"
                                        >
                                            +
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <aside className={styles.preparePane}>
                        <div className={styles.browserHeader}>
                            <div>
                                <span className={styles.kicker}>Preparation</span>
                                <h2>Up next</h2>
                            </div>
                            <span className={styles.count}>{prepared.length}</span>
                        </div>
                        <div className={styles.prepareList}>
                            {prepared.length === 0 && (
                                <p className={styles.empty}>
                                    Add tracks here while preparing your set.
                                </p>
                            )}
                            {prepared.map((song) => (
                                <div
                                    className={styles.prepareRow}
                                    draggable
                                    key={song.id}
                                    onDragEnd={() => setDraggedSong(undefined)}
                                    onDragStart={(event) => startDrag(event, song)}
                                >
                                    <div>
                                        <strong>{song.name}</strong>
                                        <span>{song.artistName}</span>
                                    </div>
                                    <div className={styles.rowActions}>
                                        <button
                                            aria-label={`Load ${song.name} to Deck A`}
                                            onClick={() => loadDeck('A', song)}
                                            type="button"
                                        >
                                            A
                                        </button>
                                        <button
                                            aria-label={`Load ${song.name} to Deck B`}
                                            onClick={() => loadDeck('B', song)}
                                            type="button"
                                        >
                                            B
                                        </button>
                                        <button
                                            aria-label={`Remove ${song.name} from preparation`}
                                            onClick={() =>
                                                setPrepared((current) =>
                                                    current.filter((item) => item.id !== song.id),
                                                )
                                            }
                                            type="button"
                                        >
                                            ×
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </aside>
                </section>
            </main>
        </div>
    );
};
