import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

// ── Data model ──────────────────────────────────────────────────────
type Card = {
  id: string;
  title: string;
  body: string;
  label: string;
  images: string[]; // images[0] is the card thumbnail (cover)
  imageMeta?: Record<string, { orig: number; size: number }>; // per-image byte sizes
  view?: "details" | "titles"; // per-note override of the global titles/details view
  coverX: number; // cover image focal point, 0-100 (object-position)
  coverY: number;
  coverZoom: number; // cover image scale, 1 = fit
  createdAt: number;
};
type Column = { id: string; title: string; cards: Card[] };
type Board = {
  id: string;
  title: string;
  columns: Column[];
  createdAt: number;
  updatedAt: number; // bumped whenever anything on the board changes
};
// An archived (binned) note keeps where it came from so it can be restored.
type ArchivedCard = { card: Card; boardId: string; colId: string; archivedAt: number };
// `labels` maps a color key to the name the user gave it (Trello-style).
type Workspace = {
  version: number;
  boards: Board[];
  activeBoardId: string;
  labels: Record<string, string>;
  archived: ArchivedCard[];
};

// Fixed color palette. The value is the swatch color; the name lives in workspace.labels.
const LABEL_COLORS: Record<string, string> = {
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
};
// Readable text color to sit on top of each label color.
const LABEL_TEXT: Record<string, string> = {
  red: "#fff",
  orange: "#fff",
  yellow: "#3a2e00",
  green: "#06310f",
  blue: "#fff",
  purple: "#fff",
};
const LABELS = Object.keys(LABEL_COLORS);

// ── Image helpers (pasted images are stored as files, referenced by name) ──
function extFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/bmp") return "bmp";
  return "png";
}
function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  return "image/png";
}
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
// Downscale + re-encode an image to a smaller JPEG (for the "compress" option).
async function compressImage(file: Blob, maxDim = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  const longest = Math.max(width, height);
  if (longest > maxDim) {
    const scale = maxDim / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.fillStyle = "#ffffff"; // flatten any transparency (JPEG has none)
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", quality);
  });
}
// Rotate an image blob by +90 or -90 degrees, keeping a lossless format where possible.
async function rotateBlob(file: Blob, degrees: 90 | -90, mime: string): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = h; // a quarter turn swaps width and height
  canvas.height = w;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2);
  bitmap.close();
  const outMime = mime === "image/jpeg" ? "image/jpeg" : "image/png";
  return new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b ?? file), outMime, outMime === "image/jpeg" ? 0.92 : undefined);
  });
}
// Cache loaded image data URLs by file name so cards don't re-read from disk.
const imageUrlCache = new Map<string, string>();

// The object-position + scale that frames a card's cover image.
function coverStyle(card: Card): CSSProperties {
  return {
    objectPosition: `${card.coverX}% ${card.coverY}%`,
    transform: `scale(${card.coverZoom})`,
    transformOrigin: `${card.coverX}% ${card.coverY}%`,
  };
}

// Loads a stored image by file name and renders it (cached across the app).
function NoteImage({
  fileName,
  className,
  style,
}: {
  fileName: string;
  className?: string;
  style?: CSSProperties;
}) {
  const [src, setSrc] = useState<string | null>(() => imageUrlCache.get(fileName) ?? null);
  useEffect(() => {
    const cached = imageUrlCache.get(fileName);
    if (cached) {
      setSrc(cached);
      return;
    }
    let alive = true;
    invoke<string>("load_image", { fileName })
      .then((b64) => {
        const url = `data:${mimeFromName(fileName)};base64,${b64}`;
        imageUrlCache.set(fileName, url);
        if (alive) setSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fileName]);
  if (!src) return <div className={"note-image-loading" + (className ? " " + className : "")} />;
  return <img className={className} src={src} alt="" draggable={false} style={style} />;
}

// The inner visual of a card (cover, label, title, body). Shared by the real
// card and the floating drag ghost so they always match.
function CardContent({
  card,
  labels,
  cardView,
}: {
  card: Card;
  labels: Record<string, string>;
  cardView: CardView;
}) {
  // A note can override the global titles/details setting for itself.
  const view = card.view ?? cardView;
  return (
    <>
      {card.images.length > 0 && (
        <div className="card-cover-wrap clickable" title="Click to reposition the image">
          <NoteImage fileName={card.images[0]} className="card-cover" style={coverStyle(card)} />
        </div>
      )}
      {card.label &&
        (labels[card.label] ? (
          <span
            className="card-chip"
            style={{ background: LABEL_COLORS[card.label], color: LABEL_TEXT[card.label] }}
          >
            {labels[card.label]}
          </span>
        ) : (
          <div className="card-label" style={{ background: LABEL_COLORS[card.label] }} />
        ))}
      <div className="card-title">{card.title || "Untitled note"}</div>
      {view === "details" && card.body && <div className="card-body">{card.body}</div>}
    </>
  );
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

function makeDefaultLabels(): Record<string, string> {
  return Object.fromEntries(LABELS.map((c) => [c, ""]));
}

function makeFirstBoard(): Board {
  return {
    id: uid(),
    title: "My Board",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    columns: [
      {
        id: uid(),
        title: "Inbox",
        cards: [
          {
            id: uid(),
            title: "Welcome to NoteStash",
            body: "Type a quick note below, hit Add, then drag cards between columns. Add more boards in the sidebar on the left, search every board from the box up top, right-click a note to give it a colored label, and paste an image into an open note to attach it.",
            label: "",
            images: [],
            coverX: 50,
            coverY: 50,
            coverZoom: 1,
            createdAt: Date.now(),
          },
        ],
      },
      { id: uid(), title: "To Do", cards: [] },
      { id: uid(), title: "Ideas", cards: [] },
      { id: uid(), title: "Done", cards: [] },
    ],
  };
}

// `withDefaultColumns` off means a blank board (settings tickbox).
function makeNewBoard(title: string, withDefaultColumns = true): Board {
  return {
    id: uid(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    columns: withDefaultColumns
      ? [
          { id: uid(), title: "To Do", cards: [] },
          { id: uid(), title: "Doing", cards: [] },
          { id: uid(), title: "Done", cards: [] },
        ]
      : [],
  };
}

function makeDefaultWorkspace(): Workspace {
  const b = makeFirstBoard();
  return { version: 2, boards: [b], activeBoardId: b.id, labels: makeDefaultLabels(), archived: [] };
}

function normalizeImageMeta(raw: any): Record<string, { orig: number; size: number }> {
  const out: Record<string, { orig: number; size: number }> = {};
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (v && typeof v.orig === "number" && typeof v.size === "number") {
        out[k] = { orig: v.orig, size: v.size };
      }
    }
  }
  return out;
}

// ── Defensive coercion (handles old single-board / unlabeled saves too) ──
function normalizeCard(raw: any): Card {
  return {
    id: typeof raw?.id === "string" ? raw.id : uid(),
    title: typeof raw?.title === "string" ? raw.title : "",
    body: typeof raw?.body === "string" ? raw.body : "",
    label: typeof raw?.label === "string" && raw.label in LABEL_COLORS ? raw.label : "",
    images: Array.isArray(raw?.images) ? raw.images.filter((s: any) => typeof s === "string") : [],
    imageMeta: normalizeImageMeta(raw?.imageMeta),
    view: raw?.view === "details" || raw?.view === "titles" ? raw.view : undefined,
    coverX: typeof raw?.coverX === "number" ? raw.coverX : 50,
    coverY: typeof raw?.coverY === "number" ? raw.coverY : 50,
    coverZoom: typeof raw?.coverZoom === "number" && raw.coverZoom >= 1 ? raw.coverZoom : 1,
    createdAt: typeof raw?.createdAt === "number" ? raw.createdAt : Date.now(),
  };
}

function normalizeColumn(raw: any): Column {
  return {
    id: typeof raw?.id === "string" ? raw.id : uid(),
    title: typeof raw?.title === "string" ? raw.title : "Untitled",
    cards: Array.isArray(raw?.cards) ? raw.cards.map(normalizeCard) : [],
  };
}

function normalizeBoard(raw: any): Board {
  const now = Date.now();
  const createdAt = typeof raw?.createdAt === "number" ? raw.createdAt : now;
  return {
    id: typeof raw?.id === "string" ? raw.id : uid(),
    title: typeof raw?.title === "string" ? raw.title : "My Board",
    createdAt,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : createdAt,
    columns: Array.isArray(raw?.columns) ? raw.columns.map(normalizeColumn) : [],
  };
}

function normalizeLabels(raw: any): Record<string, string> {
  const out = makeDefaultLabels();
  if (raw && typeof raw === "object") {
    for (const c of LABELS) if (typeof raw[c] === "string") out[c] = raw[c];
  }
  return out;
}

function normalizeArchived(raw: any): ArchivedCard[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a: any) => ({
    card: normalizeCard(a?.card),
    boardId: typeof a?.boardId === "string" ? a.boardId : "",
    colId: typeof a?.colId === "string" ? a.colId : "",
    archivedAt: typeof a?.archivedAt === "number" ? a.archivedAt : Date.now(),
  }));
}

function normalizeWorkspace(raw: any): Workspace {
  const labels = normalizeLabels(raw?.labels);
  const archived = normalizeArchived(raw?.archived);
  // New format: { boards: [...] }
  if (Array.isArray(raw?.boards) && raw.boards.length) {
    const boards = raw.boards.map(normalizeBoard);
    const activeBoardId =
      typeof raw?.activeBoardId === "string" && boards.some((b: Board) => b.id === raw.activeBoardId)
        ? raw.activeBoardId
        : boards[0].id;
    return { version: 2, boards, activeBoardId, labels, archived };
  }
  // Old single-board format: { columns: [...] } -> wrap into one board
  if (Array.isArray(raw?.columns)) {
    const b = normalizeBoard({ ...raw, title: "My Board" });
    return { version: 2, boards: [b], activeBoardId: b.id, labels, archived };
  }
  return makeDefaultWorkspace();
}

type DragCard = { cardId: string; fromColId: string };
type DropTarget = { colId: string; beforeCardId: string | null };
// Live column drag: `from`/`to` are indices, `delta` is the lifted column's
// pixel offset, `slot` is one column-plus-gap width, `dropping` enables the
// settle transition on release.
type ColDrag = { from: number; to: number; delta: number; slot: number; dropping: boolean };
type CardView = "details" | "titles";
type CardMenu = { colId: string; card: Card; x: number; y: number };

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(() => makeDefaultWorkspace());
  const [cardView, setCardView] = useState<CardView>(() =>
    localStorage.getItem("notestash.cardView") === "titles" ? "titles" : "details"
  );
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("notestash.theme") === "light" ? "light" : "dark"
  );
  // Card whose copy button was just used, so it can show a tick briefly.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyMenu, setCopyMenu] = useState<{ card: Card; x: number; y: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("notestash.sidebar") !== "closed"
  );
  const [view, setView] = useState<"board" | "archive" | "danger">("board");
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(
    () => localStorage.getItem("notestash.showUsage") !== "0"
  );
  const [defaultColumns, setDefaultColumns] = useState(
    () => localStorage.getItem("notestash.defaultColumns") !== "0"
  );
  const [usage, setUsage] = useState<{ cpu: string; ram: string }>({ cpu: "", ram: "" });
  const [sortMenu, setSortMenu] = useState(false);
  const [dragBoardId, setDragBoardId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState<{ colId: string; card: Card } | null>(null);
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [adjustingCover, setAdjustingCover] = useState<{ colId: string; card: Card } | null>(null);
  const [cardMenu, setCardMenu] = useState<CardMenu | null>(null);
  const [confirmState, setConfirmState] = useState<
    { message: string; okLabel: string; resolve: (v: boolean) => void } | null
  >(null);
  const [dragCard, setDragCard] = useState<DragCard | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; width: number } | null>(null);
  const [colDrag, setColDrag] = useState<ColDrag | null>(null);
  const [status, setStatus] = useState<string>("");

  const loadedRef = useRef(false);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const colDragRef = useRef<ColDrag | null>(null);
  const colGeomRef = useRef<{ centers: number[]; slot: number; startX: number } | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const dragCardIdRef = useRef<string | null>(null);
  const cardPointerRef = useRef<{ x: number; y: number } | null>(null);
  const cardScrollRafRef = useRef<number | null>(null);
  const boardDraggedRef = useRef(false);

  const activeBoard =
    workspace.boards.find((b) => b.id === workspace.activeBoardId) ?? workspace.boards[0];
  const labels = workspace.labels;
  const archived = workspace.archived;

  // ── Load saved workspace on startup ──
  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string>("load_board");
        if (raw && raw.trim()) setWorkspace(normalizeWorkspace(JSON.parse(raw)));
      } catch {
        // not running under Tauri, or nothing saved yet — keep default
      } finally {
        loadedRef.current = true;
      }
    })();
  }, []);

  // ── Autosave (debounced) whenever the workspace changes ──
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      invoke("save_board", { data: JSON.stringify(workspace) }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [workspace]);

  // ── Remember small UI preferences across restarts ──
  useEffect(() => {
    localStorage.setItem("notestash.cardView", cardView);
  }, [cardView]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("notestash.theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("notestash.sidebar", sidebarOpen ? "open" : "closed");
  }, [sidebarOpen]);
  useEffect(() => {
    localStorage.setItem("notestash.showUsage", showUsage ? "1" : "0");
  }, [showUsage]);
  useEffect(() => {
    localStorage.setItem("notestash.defaultColumns", defaultColumns ? "1" : "0");
  }, [defaultColumns]);

  // ── Live CPU / memory readout (only polled while it is on screen) ──
  useEffect(() => {
    if (!showUsage) {
      setUsage({ cpu: "", ram: "" });
      return;
    }
    let alive = true;
    const read = async () => {
      try {
        const [cpu, ram] = await invoke<[string, string]>("usage");
        if (alive) setUsage({ cpu, ram });
      } catch {
        if (alive) setUsage({ cpu: "n/a", ram: "n/a" });
      }
    };
    read();
    const t = setInterval(read, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [showUsage]);

  // ── Close the card context menu on Escape ──
  useEffect(() => {
    if (!cardMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCardMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardMenu]);

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 2200);
  }, []);

  // Apply an update to whichever board is currently active.
  const updateActiveBoard = (updater: (b: Board) => Board) =>
    setWorkspace((ws) => ({
      ...ws,
      boards: ws.boards.map((b) =>
        b.id === ws.activeBoardId ? { ...updater(b), updatedAt: Date.now() } : b
      ),
    }));

  // ── Label definitions (shared across all boards) ──
  const renameLabel = (color: string, name: string) =>
    setWorkspace((ws) => ({ ...ws, labels: { ...ws.labels, [color]: name } }));

  // ── Board operations (sidebar) ──
  const addBoard = () => {
    const b = makeNewBoard("New Board", defaultColumns);
    setWorkspace((ws) => ({ ...ws, boards: [...ws.boards, b], activeBoardId: b.id }));
    setEditingBoardId(b.id);
    setView("board");
  };

  const renameBoard = (id: string, title: string) =>
    setWorkspace((ws) => ({
      ...ws,
      boards: ws.boards.map((b) => (b.id === id ? { ...b, title, updatedAt: Date.now() } : b)),
    }));

  // Reorder the sidebar list by dropping one board onto another's slot.
  const moveBoardOnto = (dragId: string, overId: string) =>
    setWorkspace((ws) => {
      const from = ws.boards.findIndex((b) => b.id === dragId);
      const to = ws.boards.findIndex((b) => b.id === overId);
      if (from < 0 || to < 0 || from === to) return ws;
      const boards = [...ws.boards];
      const [moved] = boards.splice(from, 1);
      boards.splice(to, 0, moved);
      return { ...ws, boards };
    });

  const sortBoards = (by: "name" | "created" | "changed") =>
    setWorkspace((ws) => ({
      ...ws,
      boards: [...ws.boards].sort((a, b) =>
        by === "name"
          ? a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
          : by === "created"
            ? a.createdAt - b.createdAt
            : b.updatedAt - a.updatedAt
      ),
    }));

  // Hold a board and move it; a plain click still selects it.
  const startBoardDrag = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    boardDraggedRef.current = false;
    if ((e.target as HTMLElement).closest("button, input")) return;
    const startY = e.clientY;
    let started = false;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientY - startY) < 5) return;
        started = true;
        boardDraggedRef.current = true;
        setDragBoardId(id);
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const overId = el?.closest<HTMLElement>("[data-board-id]")?.getAttribute("data-board-id");
      if (overId && overId !== id) moveBoardOnto(id, overId);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragBoardId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // In-app themed confirmation. Returns a promise that resolves when the user
  // picks an option (window.confirm and the native dialog don't fit the theme).
  const confirmDelete = (message: string, okLabel = "Delete") =>
    new Promise<boolean>((resolve) => setConfirmState({ message, okLabel, resolve }));

  const deleteBoard = async (id: string) => {
    if (workspace.boards.length <= 1) {
      flash("Can't delete your only board");
      return;
    }
    const b = workspace.boards.find((x) => x.id === id);
    if (!b) return;
    if (!(await confirmDelete(`Delete board "${b.title}" and all its notes?`))) return;
    setWorkspace((ws) => {
      const boards = ws.boards.filter((x) => x.id !== id);
      const activeBoardId = ws.activeBoardId === id ? boards[0].id : ws.activeBoardId;
      return { ...ws, boards, activeBoardId };
    });
  };

  const selectBoard = (id: string) => {
    setWorkspace((ws) => ({ ...ws, activeBoardId: id }));
    setView("board");
  };

  // ── Column operations (on the active board) ──
  const addColumn = () =>
    updateActiveBoard((b) => ({
      ...b,
      columns: [...b.columns, { id: uid(), title: "New column", cards: [] }],
    }));

  const renameColumn = (colId: string, title: string) =>
    updateActiveBoard((b) => ({
      ...b,
      columns: b.columns.map((c) => (c.id === colId ? { ...c, title } : c)),
    }));

  const deleteColumn = async (colId: string) => {
    const col = activeBoard.columns.find((c) => c.id === colId);
    if (col && col.cards.length > 0) {
      if (!(await confirmDelete(`Delete "${col.title}" and its ${col.cards.length} note(s)?`))) return;
    }
    updateActiveBoard((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== colId) }));
  };

  const moveColumnIndex = (from: number, to: number) =>
    updateActiveBoard((b) => {
      if (from === to) return b;
      const cols = [...b.columns];
      const [moved] = cols.splice(from, 1);
      cols.splice(to, 0, moved);
      return { ...b, columns: cols };
    });

  // Animate an arrow-button reorder with the same slide as a drag.
  const animateColMove = (from: number, to: number) => {
    if (colDrag) return; // a move is already animating
    const boardEl = boardRef.current;
    if (!boardEl || to < 0) return;
    const cols = Array.from(boardEl.querySelectorAll<HTMLElement>(".column"));
    if (to >= cols.length) return;
    const centers = cols.map((c) => {
      const r = c.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const slot =
      centers.length > 1
        ? (centers[centers.length - 1] - centers[0]) / (centers.length - 1)
        : cols[0].getBoundingClientRect().width + 14;
    setColDrag({ from, to, delta: centers[to] - centers[from], slot, dropping: true });
    window.setTimeout(() => {
      moveColumnIndex(from, to);
      setColDrag(null);
    }, 190);
  };

  // ── Live column drag: the grabbed column lifts and follows the cursor,
  //    the others slide aside as it crosses their midpoints. ──
  const startColDrag = (e: ReactPointerEvent, from: number, colId: string) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input")) return; // header buttons / rename
    const titleClick = !!target.closest(".column-title");
    const boardEl = boardRef.current;
    if (!boardEl) return;
    const cols = Array.from(boardEl.querySelectorAll<HTMLElement>(".column"));
    if (cols.length === 0) return;
    const centers = cols.map((c) => {
      const r = c.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const slot =
      centers.length > 1
        ? (centers[centers.length - 1] - centers[0]) / (centers.length - 1)
        : cols[0].getBoundingClientRect().width + 14;
    colGeomRef.current = { centers, slot, startX: e.clientX };

    let started = false;
    const onMove = (ev: PointerEvent) => {
      const g = colGeomRef.current;
      if (!g) return;
      const delta = ev.clientX - g.startX;
      if (!started) {
        if (Math.abs(delta) < 4) return; // ignore a plain click
        started = true;
      }
      const draggedCenter = g.centers[from] + delta;
      let to = Math.round((draggedCenter - g.centers[0]) / g.slot);
      to = Math.max(0, Math.min(g.centers.length - 1, to));
      const next: ColDrag = { from, to, delta, slot: g.slot, dropping: false };
      colDragRef.current = next;
      setColDrag(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      const g = colGeomRef.current;
      const cur = colDragRef.current;
      if (!started || !g || !cur) {
        setColDrag(null);
        colDragRef.current = null;
        colGeomRef.current = null;
        if (!started && titleClick) setEditingColId(colId); // plain click on title = rename
        return;
      }
      // Glide the lifted column into its target slot, then commit the reorder.
      const restDelta = g.centers[cur.to] - g.centers[from];
      setColDrag({ ...cur, delta: restDelta, dropping: true });
      window.setTimeout(() => {
        moveColumnIndex(cur.from, cur.to);
        setColDrag(null);
        colDragRef.current = null;
        colGeomRef.current = null;
      }, 190);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  // Transform applied to each column while a column drag is in progress.
  const columnStyle = (i: number): CSSProperties | undefined => {
    if (!colDrag) return undefined;
    const { from, to, delta, slot, dropping } = colDrag;
    if (i === from) {
      return {
        transform: `translateX(${delta}px)`,
        transition: dropping ? "transform 170ms ease" : "none",
        zIndex: 50,
        position: "relative",
      };
    }
    let shift = 0;
    if (to > from && i > from && i <= to) shift = -slot;
    else if (to < from && i >= to && i < from) shift = slot;
    return { transform: `translateX(${shift}px)`, transition: "transform 170ms ease" };
  };

  // Click-and-hold any empty area of the board to scroll it left/right.
  const onPanStart = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest(".card, .column-head, button, input, textarea, a")) return;
    const boardEl = boardRef.current;
    if (!boardEl) return;
    const startX = e.clientX;
    const startScroll = boardEl.scrollLeft;
    boardEl.classList.add("is-panning");
    const onMove = (ev: MouseEvent) => {
      boardEl.scrollLeft = startScroll - (ev.clientX - startX);
    };
    const onUp = () => {
      boardEl.classList.remove("is-panning");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── Card operations (on the active board) ──
  const addCard = (colId: string, title: string, body: string) => {
    const t = title.trim();
    if (!t) return;
    const card: Card = {
      id: uid(),
      title: t,
      body: body.trim(),
      label: "",
      images: [],
      coverX: 50,
      coverY: 50,
      coverZoom: 1,
      createdAt: Date.now(),
    };
    updateActiveBoard((b) => ({
      ...b,
      columns: b.columns.map((c) => (c.id === colId ? { ...c, cards: [...c.cards, card] } : c)),
    }));
  };

  const saveCard = (colId: string, updated: Card) =>
    updateActiveBoard((b) => ({
      ...b,
      columns: b.columns.map((c) =>
        c.id === colId
          ? { ...c, cards: c.cards.map((cd) => (cd.id === updated.id ? updated : cd)) }
          : c
      ),
    }));

  const setCardLabel = (colId: string, card: Card, color: string) =>
    saveCard(colId, { ...card, label: color });

  const setCardNoteView = (colId: string, card: Card, view: CardView) =>
    saveCard(colId, { ...card, view });

  // Copy a note's text to the clipboard: the title alone, or title + details.
  const copyCardToClipboard = async (card: Card, mode: "title" | "both") => {
    const text =
      mode === "title"
        ? card.title.trim()
        : [card.title, card.body].map((s) => s.trim()).filter(Boolean).join("\n\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for webviews where the async clipboard API is unavailable.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // nothing else to try
      }
      document.body.removeChild(ta);
    }
    setCopiedId(card.id);
    window.setTimeout(() => setCopiedId((id) => (id === card.id ? null : id)), 1200);
  };

  const deleteCard = (colId: string, cardId: string) => {
    const card = activeBoard.columns.find((c) => c.id === colId)?.cards.find((cd) => cd.id === cardId);
    card?.images.forEach((f) => invoke("delete_image", { fileName: f }).catch(() => {}));
    updateActiveBoard((b) => ({
      ...b,
      columns: b.columns.map((c) =>
        c.id === colId ? { ...c, cards: c.cards.filter((cd) => cd.id !== cardId) } : c
      ),
    }));
  };

  // ── Archive (soft delete): move a note off the board into the bin ──
  const archiveCard = (colId: string, card: Card) =>
    setWorkspace((ws) => {
      const boards = ws.boards.map((b) =>
        b.id === ws.activeBoardId
          ? {
              ...b,
              columns: b.columns.map((c) =>
                c.id === colId ? { ...c, cards: c.cards.filter((cd) => cd.id !== card.id) } : c
              ),
            }
          : b
      );
      const entry: ArchivedCard = { card, boardId: ws.activeBoardId, colId, archivedAt: Date.now() };
      return { ...ws, boards, archived: [entry, ...ws.archived] };
    });

  // Restore a note to its original board/column (or the first one if that's gone).
  const restoreCard = (cardId: string) =>
    setWorkspace((ws) => {
      const entry = ws.archived.find((a) => a.card.id === cardId);
      if (!entry) return ws;
      const archivedRest = ws.archived.filter((a) => a.card.id !== cardId);
      const boards = ws.boards.map((b) => ({
        ...b,
        columns: b.columns.map((c) => ({ ...c, cards: [...c.cards] })),
      }));
      const board = boards.find((b) => b.id === entry.boardId) ?? boards[0];
      if (!board || board.columns.length === 0) return { ...ws, archived: archivedRest };
      const col = board.columns.find((c) => c.id === entry.colId) ?? board.columns[0];
      col.cards.push(entry.card);
      return { ...ws, boards, archived: archivedRest };
    });

  const deleteArchived = async (cardId: string, title: string) => {
    if (!(await confirmDelete(`Permanently delete ${title ? `"${title}"` : "this note"}? This can't be undone.`)))
      return;
    const entry = workspace.archived.find((a) => a.card.id === cardId);
    entry?.card.images.forEach((f) => invoke("delete_image", { fileName: f }).catch(() => {}));
    setWorkspace((ws) => ({ ...ws, archived: ws.archived.filter((a) => a.card.id !== cardId) }));
  };

  // ── Danger Zone ──
  const allImageNames = (): string[] => {
    const names: string[] = [];
    for (const b of workspace.boards)
      for (const c of b.columns) for (const cd of c.cards) names.push(...cd.images);
    for (const a of workspace.archived) names.push(...a.card.images);
    return names;
  };

  const deleteAllImages = async () => {
    const n = allImageNames().length;
    if (n === 0) {
      flash("No images to delete");
      return;
    }
    if (
      !(await confirmDelete(
        `Delete all ${n} image${n === 1 ? "" : "s"} from every note on every board? The notes themselves stay. This can't be undone.`,
        "Delete images"
      ))
    )
      return;
    allImageNames().forEach((f) => invoke("delete_image", { fileName: f }).catch(() => {}));
    imageUrlCache.clear();
    const stripImages = (cd: Card): Card => ({
      ...cd,
      images: [],
      coverX: 50,
      coverY: 50,
      coverZoom: 1,
    });
    setWorkspace((ws) => ({
      ...ws,
      boards: ws.boards.map((b) => ({
        ...b,
        columns: b.columns.map((c) => ({ ...c, cards: c.cards.map(stripImages) })),
      })),
      archived: ws.archived.map((a) => ({ ...a, card: stripImages(a.card) })),
    }));
    flash("All images deleted");
  };

  const deleteEverything = async () => {
    if (
      !(await confirmDelete(
        "Reset NoteStash and delete EVERYTHING - all boards, columns, notes, labels, and images? This cannot be undone.",
        "Delete everything"
      ))
    )
      return;
    allImageNames().forEach((f) => invoke("delete_image", { fileName: f }).catch(() => {}));
    imageUrlCache.clear();
    setWorkspace(makeDefaultWorkspace());
    setView("board");
    flash("Everything reset");
  };

  const moveCard = (
    cardId: string,
    fromColId: string,
    toColId: string,
    beforeCardId: string | null
  ) =>
    updateActiveBoard((b) => {
      const cols = b.columns.map((c) => ({ ...c, cards: [...c.cards] }));
      const from = cols.find((c) => c.id === fromColId);
      const to = cols.find((c) => c.id === toColId);
      if (!from || !to) return b;
      const card = from.cards.find((cd) => cd.id === cardId);
      if (!card) return b;
      from.cards = from.cards.filter((cd) => cd.id !== cardId);
      const target = from === to ? from.cards : to.cards;
      const idx = beforeCardId ? target.findIndex((cd) => cd.id === beforeCardId) : -1;
      if (idx < 0) target.push(card);
      else target.splice(idx, 0, card);
      if (from !== to) to.cards = target;
      return { ...b, columns: cols };
    });

  const findCard = (colId: string, cardId: string): Card | null =>
    activeBoard.columns.find((c) => c.id === colId)?.cards.find((cd) => cd.id === cardId) ?? null;

  // Duplicate a note right below the original: title, body, label, cover framing,
  // and its images (each image is copied to a new file so the two are independent).
  const duplicateCard = async (colId: string, card: Card) => {
    const newImages: string[] = [];
    const newMeta: Record<string, { orig: number; size: number }> = {};
    for (const fileName of card.images) {
      const ext = fileName.split(".").pop() || "png";
      const newName = `${uid()}.${ext}`;
      try {
        const b64 = await invoke<string>("load_image", { fileName });
        await invoke("save_image", { fileName: newName, dataBase64: b64 });
        newImages.push(newName);
        const m = card.imageMeta?.[fileName];
        if (m) newMeta[newName] = { ...m };
      } catch {
        // skip an image that fails to copy
      }
    }
    const copy: Card = {
      ...card,
      id: uid(),
      images: newImages,
      imageMeta: newMeta,
      createdAt: Date.now(),
    };
    updateActiveBoard((b) => ({
      ...b,
      columns: b.columns.map((c) => {
        if (c.id !== colId) return c;
        const idx = c.cards.findIndex((cd) => cd.id === card.id);
        const cards = [...c.cards];
        cards.splice(idx < 0 ? cards.length : idx + 1, 0, copy);
        return { ...c, cards };
      }),
    }));
  };

  // Scroll a cards column when the drag pointer nears its top/bottom edge.
  const autoScrollCards = (scroller: HTMLElement, clientY: number) => {
    const r = scroller.getBoundingClientRect();
    const edge = 64;
    const maxSpeed = 22;
    if (clientY < r.top + edge) {
      const d = Math.min(1, (r.top + edge - clientY) / edge);
      scroller.scrollTop -= Math.ceil(maxSpeed * d);
    } else if (clientY > r.bottom - edge) {
      const d = Math.min(1, (clientY - (r.bottom - edge)) / edge);
      scroller.scrollTop += Math.ceil(maxSpeed * d);
    }
  };

  // Figure out which column and insertion point the pointer is over, from the DOM.
  const updateCardDropTarget = (x: number, y: number, draggedId: string) => {
    const board = boardRef.current;
    if (!board) return;
    // Pick the target column by horizontal position, so a short/empty column is
    // droppable anywhere in its width even when the pointer is below its body.
    const columns = Array.from(board.querySelectorAll<HTMLElement>(".column"));
    let colSection: HTMLElement | null = null;
    for (const c of columns) {
      const r = c.getBoundingClientRect();
      if (x >= r.left && x <= r.right) {
        colSection = c;
        break;
      }
    }
    if (!colSection) return; // pointer is in a gap between columns; keep last target
    const colId = colSection.getAttribute("data-col-id");
    if (!colId) return;
    const cardsEl = colSection.querySelector<HTMLElement>(".cards");
    let beforeCardId: string | null = null;
    if (cardsEl) {
      for (const ce of Array.from(cardsEl.querySelectorAll<HTMLElement>(".card"))) {
        const cid = ce.getAttribute("data-card-id");
        if (!cid || cid === draggedId) continue;
        const r = ce.getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          beforeCardId = cid;
          break;
        }
      }
    }
    const prev = dropTargetRef.current;
    if (prev && prev.colId === colId && prev.beforeCardId === beforeCardId) return;
    const next = { colId, beforeCardId };
    dropTargetRef.current = next;
    setDropTarget(next);
  };

  // Continuous auto-scroll loop (rAF works because this is a pointer drag, not
  // a native HTML5 drag). Also refreshes the drop indicator as content scrolls.
  const startCardScrollLoop = () => {
    const loop = () => {
      const pos = cardPointerRef.current;
      if (pos) {
        const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
        const scroller = el?.closest<HTMLElement>(".cards");
        if (scroller) {
          autoScrollCards(scroller, pos.y);
          if (dragCardIdRef.current) updateCardDropTarget(pos.x, pos.y, dragCardIdRef.current);
        }
      }
      cardScrollRafRef.current = requestAnimationFrame(loop);
    };
    cardScrollRafRef.current = requestAnimationFrame(loop);
  };

  const stopCardScrollLoop = () => {
    if (cardScrollRafRef.current != null) {
      cancelAnimationFrame(cardScrollRafRef.current);
      cardScrollRafRef.current = null;
    }
    cardPointerRef.current = null;
  };

  // ── Pointer-based card drag (so wheel-scroll and edge auto-scroll work) ──
  const startCardPointerDrag = (e: ReactPointerEvent, colId: string, cardId: string) => {
    if (e.button !== 0) return;
    const downTarget = e.target as HTMLElement;
    if (downTarget.closest("button, input, textarea, a")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    const width = rect.width;
    const startX = e.clientX;
    const startY = e.clientY;
    dragCardIdRef.current = cardId;
    let started = false;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        started = true;
        setDragCard({ cardId, fromColId: colId });
        startCardScrollLoop();
      }
      cardPointerRef.current = { x: ev.clientX, y: ev.clientY };
      setDragGhost({ x: ev.clientX - grabX, y: ev.clientY - grabY, width });
      updateCardDropTarget(ev.clientX, ev.clientY, cardId);
    };
    const onWheel = (ev: WheelEvent) => {
      if (!started) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const scroller = el?.closest<HTMLElement>(".cards");
      if (scroller) {
        ev.preventDefault();
        scroller.scrollTop += ev.deltaY;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("wheel", onWheel);
      stopCardScrollLoop();
      if (started) {
        const dt = dropTargetRef.current;
        if (dt) moveCard(cardId, colId, dt.colId, dt.beforeCardId);
        setDragCard(null);
        setDropTarget(null);
        setDragGhost(null);
        dropTargetRef.current = null;
      } else {
        const c = findCard(colId, cardId);
        if (c) {
          if (downTarget.closest(".card-cover-wrap")) setAdjustingCover({ colId, card: c });
          else setEditingCard({ colId, card: c });
        }
      }
      dragCardIdRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("wheel", onWheel, { passive: false });
  };

  // ── Cross-board search ──
  const q = query.trim().toLowerCase();
  const results = q
    ? workspace.boards.flatMap((b) =>
        b.columns.flatMap((c) =>
          c.cards
            .filter((card) => (card.title + "\n" + card.body).toLowerCase().includes(q))
            .map((card) => ({ board: b, col: c, card }))
        )
      )
    : [];

  const openResult = (boardId: string, colId: string, card: Card) => {
    setWorkspace((ws) => ({ ...ws, activeBoardId: boardId }));
    setEditingCard({ colId, card });
    setQuery("");
  };

  // ── Export / Import (whole workspace) ──
  const exportBoard = async () => {
    try {
      const path = await save({
        defaultPath: "notestash-backup.json",
        filters: [{ name: "NoteStash backup", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("export_board", { path, data: JSON.stringify(workspace, null, 2) });
      flash("Backup exported");
    } catch {
      flash("Export failed");
    }
  };

  const importBoard = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "NoteStash backup", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return;
      if (!(await confirmDelete("Replace ALL your boards with this backup?", "Replace"))) return;
      const text = await invoke<string>("import_board", { path });
      setWorkspace(normalizeWorkspace(JSON.parse(text)));
      flash("Backup imported");
    } catch {
      flash("Import failed - not a valid backup file");
    }
  };

  const link = (url: string) => () => {
    openUrl(url).catch(() => {});
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="btn btn-ghost icon-only"
            onClick={() => setSidebarOpen((o) => !o)}
            title="Show / hide boards"
          >
            ☰
          </button>
          <div className="brand">
            <span className="brand-mark">▦</span>
            <h1>NoteStash</h1>
            <button
              className="brand-theme"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.5" fill="currentColor" />
                  <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.22 5.22l1.84 1.84M16.94 16.94l1.84 1.84M18.78 5.22l-1.84 1.84M7.06 16.94l-1.84 1.84" />
                  </g>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7z"
                    fill="currentColor"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div className="topbar-center">
          <input
            className="search-input"
            placeholder="Search notes across all boards..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
          {q && (
            <div className="search-results">
              {results.length === 0 ? (
                <div className="search-empty">No matches</div>
              ) : (
                <>
                  {results.slice(0, 12).map(({ board: rb, col, card }) => (
                    <button
                      key={card.id}
                      className="search-item"
                      onClick={() => openResult(rb.id, col.id, card)}
                    >
                      <span className="search-item-title">{card.title || "Untitled note"}</span>
                      <span className="search-item-meta">
                        {rb.title} / {col.title}
                      </span>
                    </button>
                  ))}
                  {results.length > 12 && (
                    <div className="search-empty">+{results.length - 12} more</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="topbar-actions">
          {status && <span className="status">{status}</span>}
          <select
            className="view-select"
            value={cardView}
            onChange={(e) => setCardView(e.target.value as CardView)}
            title="How much of each note to show"
          >
            <option value="details">Show titles + details</option>
            <option value="titles">Show titles only</option>
          </select>
          <button className="btn btn-ghost" onClick={importBoard}>Import</button>
          <button className="btn btn-ghost" onClick={exportBoard}>Export</button>
          <button
            className="btn btn-ghost theme-toggle"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="body">
        <aside className={"sidebar" + (sidebarOpen ? "" : " collapsed")}>
          <div className="sidebar-head">
            <span className="sidebar-title">Boards</span>
            <div className="sidebar-head-tools">
              <button className="icon-btn" title="Add board" onClick={addBoard}>+</button>
              <div className="sort-wrap">
                <button
                  className="icon-btn"
                  title="Sort boards"
                  onClick={() => setSortMenu((o) => !o)}
                >
                  ⇅
                </button>
                {sortMenu && (
                  <>
                    <div className="menu-overlay" onMouseDown={() => setSortMenu(false)} />
                    <div className="sort-menu">
                      <button
                        className="context-menu-open"
                        onClick={() => {
                          sortBoards("name");
                          setSortMenu(false);
                        }}
                      >
                        Alphabetically
                      </button>
                      <button
                        className="context-menu-open"
                        onClick={() => {
                          sortBoards("created");
                          setSortMenu(false);
                        }}
                      >
                        Date Created
                      </button>
                      <button
                        className="context-menu-open"
                        onClick={() => {
                          sortBoards("changed");
                          setSortMenu(false);
                        }}
                      >
                        Last Changed
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="board-list">
            {workspace.boards.map((b) => (
              <div
                key={b.id}
                data-board-id={b.id}
                className={
                  "board-item" +
                  (view === "board" && b.id === workspace.activeBoardId ? " active" : "") +
                  (dragBoardId === b.id ? " is-board-drag" : "")
                }
                onPointerDown={(e) => startBoardDrag(e, b.id)}
                onClick={() => {
                  if (boardDraggedRef.current) {
                    boardDraggedRef.current = false;
                    return;
                  }
                  selectBoard(b.id);
                }}
              >
                {editingBoardId === b.id ? (
                  <input
                    className="board-rename"
                    autoFocus
                    defaultValue={b.title}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      renameBoard(b.id, e.target.value.trim() || "Untitled");
                      setEditingBoardId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingBoardId(null);
                    }}
                  />
                ) : (
                  <span className="board-name">{b.title}</span>
                )}
                <div className="board-tools">
                  <button
                    className="board-tool"
                    title="Rename board"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingBoardId(b.id);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="board-tool del"
                    title="Delete board"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBoard(b.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="sidebar-bottom">
            <div
              className={"board-item" + (view === "archive" ? " active" : "")}
              onClick={() => setView("archive")}
            >
              <span className="board-icon">🗑</span>
              <span className="board-name">Archive</span>
              {archived.length > 0 && <span className="count">{archived.length}</span>}
            </div>
            <div
              className={"board-item danger-entry" + (view === "danger" ? " active" : "")}
              onClick={() => setView("danger")}
            >
              <span className="board-icon">⚠</span>
              <span className="board-name">Danger Zone</span>
            </div>
          </div>
        </aside>

        {view === "archive" ? (
          <main className="archive-view">
            <div className="archive-head">
              <h2>Archived notes</h2>
              <span className="archive-sub">
                {archived.length === 0
                  ? "Nothing here yet"
                  : `${archived.length} note${archived.length === 1 ? "" : "s"} - restore one to a board, or delete it for good`}
              </span>
            </div>
            {archived.length > 0 && (
              <div className="archive-grid">
                {archived.map((a) => (
                  <article className="archive-card" key={a.card.id}>
                    {a.card.images.length > 0 && (
                      <div className="card-cover-wrap">
                        <NoteImage
                          fileName={a.card.images[0]}
                          className="card-cover"
                          style={coverStyle(a.card)}
                        />
                      </div>
                    )}
                    {a.card.label &&
                      (labels[a.card.label] ? (
                        <span
                          className="card-chip"
                          style={{
                            background: LABEL_COLORS[a.card.label],
                            color: LABEL_TEXT[a.card.label],
                          }}
                        >
                          {labels[a.card.label]}
                        </span>
                      ) : (
                        <div
                          className="card-label"
                          style={{ background: LABEL_COLORS[a.card.label] }}
                        />
                      ))}
                    <div className="card-title">{a.card.title || "Untitled note"}</div>
                    {a.card.body && <div className="card-body">{a.card.body}</div>}
                    <div className="archive-card-actions">
                      <button className="btn btn-ghost" onClick={() => restoreCard(a.card.id)}>
                        Restore
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => deleteArchived(a.card.id, a.card.title)}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </main>
        ) : view === "danger" ? (
          <main className="danger-view">
            <div className="archive-head">
              <h2>Danger Zone</h2>
              <span className="archive-sub">
                Irreversible actions. Export a backup first if you are unsure.
              </span>
            </div>
            <div className="danger-list">
              <div className="danger-option">
                <div className="danger-option-text">
                  <h3>Delete all images</h3>
                  <p>
                    Removes every image from every note on every board, and from the archive. The
                    notes themselves stay. This cannot be undone.
                  </p>
                </div>
                <button className="btn btn-danger" onClick={deleteAllImages}>
                  Delete all images
                </button>
              </div>
              <div className="danger-option">
                <div className="danger-option-text">
                  <h3>Delete everything</h3>
                  <p>
                    Resets NoteStash to a clean slate: all boards, columns, notes, labels, and
                    images are erased. This cannot be undone.
                  </p>
                </div>
                <button className="btn btn-danger" onClick={deleteEverything}>
                  Delete everything
                </button>
              </div>
            </div>
          </main>
        ) : (
          <main className="board" ref={boardRef} onMouseDown={onPanStart}>
            {activeBoard.columns.map((col, colIndex) => (
            <section
              key={col.id}
              data-col-id={col.id}
              className={
                "column" +
                (dropTarget?.colId === col.id ? " is-drop" : "") +
                (colDrag?.from === colIndex ? " is-col-lift" : "")
              }
              style={columnStyle(colIndex)}
            >
              <div
                className="column-head"
                onPointerDown={(e) => startColDrag(e, colIndex, col.id)}
              >
                {editingColId === col.id ? (
                  <input
                    className="column-title-input"
                    autoFocus
                    defaultValue={col.title}
                    onBlur={(e) => {
                      renameColumn(col.id, e.target.value.trim() || "Untitled");
                      setEditingColId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingColId(null);
                    }}
                  />
                ) : (
                  <h2 className="column-title" title="Click to rename">
                    {col.title}
                    <span className="count">{col.cards.length}</span>
                  </h2>
                )}
                <div className="column-tools">
                  <button
                    className="icon-btn"
                    title="Move left"
                    disabled={colIndex === 0}
                    onClick={() => animateColMove(colIndex, colIndex - 1)}
                  >
                    ‹
                  </button>
                  <button
                    className="icon-btn"
                    title="Move right"
                    disabled={colIndex === activeBoard.columns.length - 1}
                    onClick={() => animateColMove(colIndex, colIndex + 1)}
                  >
                    ›
                  </button>
                  <button
                    className="icon-btn danger"
                    title="Delete column"
                    onClick={() => deleteColumn(col.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="cards">
                {col.cards.map((card) => (
                  <div key={card.id}>
                    {dropTarget?.colId === col.id &&
                      dropTarget?.beforeCardId === card.id && <div className="drop-line" />}
                    <article
                      className={"card" + (dragCard?.cardId === card.id ? " is-dragging" : "")}
                      data-card-id={card.id}
                      onPointerDown={(e) => startCardPointerDrag(e, col.id, card.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCardMenu({ colId: col.id, card, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <button
                        type="button"
                        className="card-copy"
                        title="Copy note to clipboard"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setCopyMenu({ card, x: r.right, y: r.bottom + 4 });
                        }}
                      >
                        {copiedId === card.id ? "✓" : "⧉"}
                      </button>
                      <CardContent card={card} labels={labels} cardView={cardView} />
                    </article>
                  </div>
                ))}
                {dropTarget?.colId === col.id &&
                  dropTarget?.beforeCardId === null &&
                  dragCard && <div className="drop-line" />}
              </div>

              <Composer onAdd={(title, body) => addCard(col.id, title, body)} />
            </section>
          ))}
          </main>
        )}
      </div>

      <footer className="global-footer">
        <div className="footer-meta">
          <span className="footer-version">v{__APP_VERSION__}</span>
          {showUsage && (
            <>
              <span className="sep">|</span>
              <span className="footer-version">CPU: {usage.cpu || "..."}</span>
              <span className="sep">|</span>
              <span className="footer-version">RAM: {usage.ram || "..."}</span>
            </>
          )}
        </div>
        <div className="footer-links">
          <a className="link-coffee" onClick={link("https://buymeacoffee.com/eeriegoesd")}>
            Support This Project
          </a>
          <span className="sep">|</span>
          <span>Made by</span>
          <a className="link-eerie" onClick={link("https://eeriegoesd.com")}>EERIE</a>
          <span className="sep">|</span>
          <a className="link-dim" onClick={link("https://github.com/EerieGoesD/notestash/issues/new?template=bug-report.md")}>
            Report Issue
          </a>
          <span className="sep">|</span>
          <a className="link-dim" onClick={link("https://github.com/EerieGoesD/notestash/discussions")}>
            Feedback
          </a>
          <span className="sep">|</span>
          <a className="link-dim" onClick={link("https://github.com/EerieGoesD/notestash/issues/new?template=feature-request.md")}>
            Feature Request
          </a>
        </div>
      </footer>

      {view === "board" && (
        <button className="add-fab" type="button" title="New column" onClick={addColumn}>
          <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
          </svg>
          <span>Column</span>
        </button>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="settings-title">Settings</h2>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={showUsage}
                onChange={(e) => setShowUsage(e.target.checked)}
              />
              <span>
                Show CPU + Memory usage
                <span className="settings-hint">In the footer, for NoteStash only</span>
              </span>
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={defaultColumns}
                onChange={(e) => setDefaultColumns(e.target.checked)}
              />
              <span>
                Start new boards with To Do / Doing / Done
                <span className="settings-hint">Off means a new board starts empty</span>
              </span>
            </label>
            <div className="modal-actions">
              <div className="spacer" />
              <button className="btn btn-accent" onClick={() => setShowSettings(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {dragGhost &&
        dragCard &&
        (() => {
          const gc = findCard(dragCard.fromColId, dragCard.cardId);
          return gc ? (
            <div
              className="card-ghost"
              style={{ left: dragGhost.x, top: dragGhost.y, width: dragGhost.width }}
            >
              <div className="card">
                <CardContent card={gc} labels={labels} cardView={cardView} />
              </div>
            </div>
          ) : null;
        })()}

      {copyMenu && (
        <>
          <div
            className="menu-overlay"
            onMouseDown={() => setCopyMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCopyMenu(null);
            }}
          />
          <div
            className="context-menu copy-menu"
            style={{
              left: Math.max(8, Math.min(copyMenu.x - 210, window.innerWidth - 218)),
              top: Math.max(8, Math.min(copyMenu.y, window.innerHeight - 110)),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="context-menu-open"
              onClick={() => {
                copyCardToClipboard(copyMenu.card, "title");
                setCopyMenu(null);
              }}
            >
              Copy title only
            </button>
            <button
              className="context-menu-open"
              onClick={() => {
                copyCardToClipboard(copyMenu.card, "both");
                setCopyMenu(null);
              }}
            >
              Copy title + description
            </button>
          </div>
        </>
      )}

      {cardMenu && (
        <>
          <div
            className="menu-overlay"
            onMouseDown={() => setCardMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCardMenu(null);
            }}
          />
          <div
            className="context-menu"
            style={{
              left: Math.max(8, Math.min(cardMenu.x, window.innerWidth - 258)),
              top: Math.max(8, Math.min(cardMenu.y, window.innerHeight - 476)),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="context-menu-title">Label</div>
            <LabelDropdown
              labels={labels}
              currentLabel={cardMenu.card.label}
              onAssign={(color) => {
                setCardLabel(cardMenu.colId, cardMenu.card, color);
                setCardMenu(null);
              }}
              onRename={renameLabel}
            />
            <div className="context-menu-title">Show this note</div>
            <select
              className="view-select context-view-select"
              value={cardMenu.card.view ?? cardView}
              onChange={(e) => {
                setCardNoteView(cardMenu.colId, cardMenu.card, e.target.value as CardView);
                setCardMenu(null);
              }}
              title="How much of this note to show"
            >
              <option value="details">Show title + detail</option>
              <option value="titles">Show title only</option>
            </select>
            <span className="context-menu-hint">Only this note, not the whole board</span>
            <button
              className="context-menu-open"
              onClick={() => {
                setEditingCard({ colId: cardMenu.colId, card: cardMenu.card });
                setCardMenu(null);
              }}
            >
              Open Note
            </button>
            <button
              className="context-menu-open"
              onClick={() => {
                duplicateCard(cardMenu.colId, cardMenu.card);
                setCardMenu(null);
              }}
            >
              Duplicate Note
            </button>
            <button
              className="context-menu-open"
              onClick={() => {
                archiveCard(cardMenu.colId, cardMenu.card);
                setCardMenu(null);
              }}
            >
              Archive Note
            </button>
            <button
              className="context-menu-delete"
              onClick={async () => {
                const c = cardMenu.card;
                const colId = cardMenu.colId;
                setCardMenu(null);
                if (await confirmDelete(`Delete ${c.title ? `"${c.title}"` : "this note"}?`)) {
                  deleteCard(colId, c.id);
                }
              }}
            >
              Delete Note
            </button>
          </div>
        </>
      )}

      {editingCard && (
        <CardEditor
          card={editingCard.card}
          labels={labels}
          onRenameLabel={renameLabel}
          onSave={(updated) => {
            saveCard(editingCard.colId, updated);
            setEditingCard(null);
          }}
          onDelete={async () => {
            const c = editingCard.card;
            const colId = editingCard.colId;
            if (!(await confirmDelete(`Delete ${c.title ? `"${c.title}"` : "this note"}?`))) return;
            deleteCard(colId, c.id);
            setEditingCard(null);
          }}
          onArchive={() => {
            archiveCard(editingCard.colId, editingCard.card);
            setEditingCard(null);
          }}
          onClose={() => setEditingCard(null)}
        />
      )}

      {adjustingCover && adjustingCover.card.images.length > 0 && (
        <CoverAdjuster
          fileName={adjustingCover.card.images[0]}
          initialX={adjustingCover.card.coverX}
          initialY={adjustingCover.card.coverY}
          initialZoom={adjustingCover.card.coverZoom}
          onSave={(x, y, zoom) => {
            saveCard(adjustingCover.colId, {
              ...adjustingCover.card,
              coverX: x,
              coverY: y,
              coverZoom: zoom,
            });
            setAdjustingCover(null);
          }}
          onClose={() => setAdjustingCover(null)}
        />
      )}

      {confirmState && (
        <ConfirmDialog
          message={confirmState.message}
          okLabel={confirmState.okLabel}
          onConfirm={() => {
            confirmState.resolve(true);
            setConfirmState(null);
          }}
          onCancel={() => {
            confirmState.resolve(false);
            setConfirmState(null);
          }}
        />
      )}
    </div>
  );
}

// ── Themed confirmation dialog ──
function ConfirmDialog({
  message,
  okLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  okLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-message">{message}</p>
        <div className="modal-actions">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" autoFocus onClick={onConfirm}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Cover image position adjuster: drag the image to set its focal point ──
function CoverAdjuster({
  fileName,
  initialX,
  initialY,
  initialZoom,
  onSave,
  onClose,
}: {
  fileName: string;
  initialX: number;
  initialY: number;
  initialZoom: number;
  onSave: (x: number, y: number, zoom: number) => void;
  onClose: () => void;
}) {
  const [x, setX] = useState(initialX);
  const [y, setY] = useState(initialY);
  const [zoom, setZoom] = useState(initialZoom);
  const frameRef = useRef<HTMLDivElement | null>(null);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));

  const onPointerDown = (e: ReactPointerEvent) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = x;
    const baseY = y;
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - startX) / rect.width) * 100;
      const dy = ((ev.clientY - startY) / rect.height) * 100;
      setX(clamp(baseX - dx));
      setY(clamp(baseY - dy));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Scroll to zoom. Non-passive so we can stop the page from scrolling.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.max(1, Math.min(3, z - e.deltaY * 0.0015)));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="cover-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cover-frame" ref={frameRef} onPointerDown={onPointerDown}>
          <NoteImage
            fileName={fileName}
            className="cover-frame-img"
            style={{
              objectPosition: `${x}% ${y}%`,
              transform: `scale(${zoom})`,
              transformOrigin: `${x}% ${y}%`,
            }}
          />
        </div>
        <span className="modal-hint">Drag to reposition, scroll to zoom</span>
        <div className="modal-actions">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setX(50);
              setY(50);
              setZoom(1);
            }}
          >
            Reset
          </button>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={() => onSave(x, y, zoom)}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Shared label picker (assign a label + rename each color) ──
function LabelPicker({
  labels,
  currentLabel,
  onAssign,
  onRename,
}: {
  labels: Record<string, string>;
  currentLabel: string;
  onAssign: (color: string) => void;
  onRename: (color: string, name: string) => void;
}) {
  return (
    <div className="label-picker">
      {LABELS.map((color) => (
        <div className="label-pick-row" key={color}>
          <button
            type="button"
            className={"label-color" + (currentLabel === color ? " active" : "")}
            style={{ background: LABEL_COLORS[color], color: LABEL_TEXT[color] }}
            onClick={() => onAssign(color)}
            title="Use this label"
          >
            {currentLabel === color ? "✓" : ""}
          </button>
          <input
            className="label-name-input"
            value={labels[color] ?? ""}
            placeholder={`${color} (name optional)`}
            onChange={(e) => onRename(color, e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ))}
      <button type="button" className="label-clear" onClick={() => onAssign("")}>
        {currentLabel === "" ? "✓ " : ""}No label
      </button>
    </div>
  );
}

// ── Collapsed label dropdown: a trigger that shows the current label, and
//    a popover (with color + name) to pick or rename. Shared by the note
//    editor and the right-click menu. ──
function LabelDropdown({
  labels,
  currentLabel,
  onAssign,
  onRename,
  direction = "down",
}: {
  labels: Record<string, string>;
  currentLabel: string;
  onAssign: (color: string) => void;
  onRename: (color: string, name: string) => void;
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="label-control">
      <button type="button" className="label-trigger" onClick={() => setOpen((v) => !v)}>
        {currentLabel ? (
          <span
            className="trigger-chip"
            style={{ background: LABEL_COLORS[currentLabel], color: LABEL_TEXT[currentLabel] }}
          >
            {labels[currentLabel] || currentLabel}
          </span>
        ) : (
          <span className="trigger-none">No label</span>
        )}
        <span className="trigger-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="label-popover-backdrop" onClick={() => setOpen(false)} />
          <div className={"label-popover" + (direction === "up" ? " up" : "")}>
            <LabelPicker
              labels={labels}
              currentLabel={currentLabel}
              onAssign={(c) => {
                onAssign(c);
                setOpen(false);
              }}
              onRename={onRename}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ── Quick-add composer: a single line that expands to reveal a details
//    field once you click into it (so people see details are possible). ──
function Composer({ onAdd }: { onAdd: (title: string, body: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [active, setActive] = useState(false);
  const expanded = active || title.trim().length > 0 || body.trim().length > 0;

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    onAdd(t, body.trim());
    setTitle("");
    setBody("");
    setActive(false);
  };

  return (
    <div
      className={"composer" + (expanded ? " expanded" : "")}
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(false);
      }}
    >
      <textarea
        className="composer-input"
        placeholder="Write a note..."
        value={title}
        rows={expanded ? 2 : 1}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {expanded && (
        <>
          <textarea
            className="composer-input composer-details"
            placeholder="Details (optional)"
            value={body}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            className="btn btn-accent composer-add"
            onClick={submit}
            disabled={!title.trim()}
          >
            Add
          </button>
        </>
      )}
    </div>
  );
}

// ── Modal editor for a single card ──
function CardEditor({
  card,
  labels,
  onRenameLabel,
  onSave,
  onDelete,
  onArchive,
  onClose,
}: {
  card: Card;
  labels: Record<string, string>;
  onRenameLabel: (color: string, name: string) => void;
  onSave: (c: Card) => void;
  onDelete: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [label, setLabel] = useState(card.label);
  const [images, setImages] = useState<string[]>(card.images);
  const [imageMeta, setImageMeta] = useState<Record<string, { orig: number; size: number }>>(
    card.imageMeta ?? {}
  );
  const [coverX, setCoverX] = useState(card.coverX);
  const [coverY, setCoverY] = useState(card.coverY);
  const [coverZoom, setCoverZoom] = useState(card.coverZoom);
  const [showCover, setShowCover] = useState(false);
  // Images pasted in THIS session (not yet saved). We keep each one's original
  // blob so its per-image "Compress" box can be ticked/unticked freely; the
  // compression is only committed to disk when the card is saved. Once a card is
  // saved and reopened, its images are no longer in here, so the box is gone.
  const sessionImages = useRef<
    Map<string, { origBlob: Blob; origSize: number; compressed?: { blob: Blob; size: number } }>
  >(new Map());
  const [compressPick, setCompressPick] = useState<Record<string, boolean>>({});
  // Pre-rotation files, deleted from disk only when the card is saved (so Cancel
  // keeps the note's original images intact).
  const replacedOnSave = useRef<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePaste = async (e: ReactClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const wasEmpty = images.length === 0;
    let added = false;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const fileName = `${uid()}.${extFromMime(item.type)}`;
        try {
          const b64 = await blobToBase64(file);
          await invoke("save_image", { fileName, dataBase64: b64 });
          sessionImages.current.set(fileName, { origBlob: file, origSize: file.size });
          setImages((prev) => [...prev, fileName]);
          setImageMeta((prev) => ({
            ...prev,
            [fileName]: { orig: file.size, size: file.size },
          }));
          added = true;
        } catch {
          // ignore a failed paste
        }
      }
    }
    // First image on this note becomes the cover: let them frame it right away.
    if (wasEmpty && added) setShowCover(true);
  };

  const removeImage = (fileName: string) => {
    setImages((prev) => prev.filter((f) => f !== fileName));
    setImageMeta((prev) => {
      const next = { ...prev };
      delete next[fileName];
      return next;
    });
    sessionImages.current.delete(fileName);
    setCompressPick((prev) => {
      const next = { ...prev };
      delete next[fileName];
      return next;
    });
    invoke("delete_image", { fileName }).catch(() => {});
  };

  // Make an image the card thumbnail by moving it to the front (images[0] = cover).
  const setAsCover = (fileName: string) => {
    setImages((prev) =>
      prev[0] === fileName ? prev : [fileName, ...prev.filter((f) => f !== fileName)]
    );
  };

  // Rotate an image a quarter turn. The rotated version becomes a new file; the
  // old one is removed on save (see replacedOnSave), so a Cancel is safe.
  const rotateEditorImage = async (fileName: string, degrees: 90 | -90) => {
    const ext = fileName.split(".").pop()?.toLowerCase() || "png";
    const mime = mimeFromName(fileName);
    try {
      const sess = sessionImages.current.get(fileName);
      let srcBlob: Blob;
      if (sess) {
        srcBlob = sess.origBlob;
      } else {
        const b64 = await invoke<string>("load_image", { fileName });
        srcBlob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
      }
      const rotated = await rotateBlob(srcBlob, degrees, mime);
      const newName = `${uid()}.${ext}`;
      await invoke("save_image", { fileName: newName, dataBase64: await blobToBase64(rotated) });
      replacedOnSave.current.push(fileName);
      setImages((prev) => prev.map((f) => (f === fileName ? newName : f)));
      setImageMeta((prev) => {
        const next = { ...prev };
        delete next[fileName];
        next[newName] = { orig: rotated.size, size: rotated.size };
        return next;
      });
      if (sess) {
        sessionImages.current.delete(fileName);
        sessionImages.current.set(newName, { origBlob: rotated, origSize: rotated.size });
        const wasPicked = !!compressPick[fileName];
        setCompressPick((prev) => {
          const next = { ...prev };
          delete next[fileName];
          if (wasPicked) next[newName] = true;
          return next;
        });
        // If Compress was ticked for this image, recompute it for the rotated one.
        if (wasPicked) {
          try {
            const c = await compressImage(rotated);
            const s = sessionImages.current.get(newName);
            if (s && c.size < rotated.size) s.compressed = { blob: c, size: c.size };
            setCompressPick((prev) => ({ ...prev }));
          } catch {
            // leave it uncompressed if it fails
          }
        }
      }
    } catch {
      // ignore a failed rotation
    }
  };

  // Tick/untick a single image's "Compress" box. On the first tick we compute
  // (and cache) the compressed version so the thumbnail can show the saving.
  // Nothing is written to disk here - it's committed when the card is saved.
  const toggleImageCompress = async (fileName: string, checked: boolean) => {
    setCompressPick((prev) => ({ ...prev, [fileName]: checked }));
    if (!checked) return;
    const sess = sessionImages.current.get(fileName);
    if (!sess || sess.compressed) return;
    try {
      const c = await compressImage(sess.origBlob);
      sess.compressed = { blob: c, size: c.size };
      setCompressPick((prev) => ({ ...prev })); // re-render to show the projected size
    } catch {
      // leave it as original if compression fails
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onPaste={handlePaste}>
        <input
          className="modal-title"
          autoFocus
          placeholder="Note title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="modal-body"
          placeholder="Details (optional)"
          value={body}
          rows={images.length > 0 ? 6 : 12}
          onChange={(e) => setBody(e.target.value)}
        />
        {images.length > 0 && (
          <>
            <div className="modal-images">
              {images.map((fileName) => {
                const meta = imageMeta[fileName];
                const isCover = fileName === images[0];
                const sess = sessionImages.current.get(fileName);
                const picked = !!compressPick[fileName];
                // Original size: from the fresh blob, or from saved meta.
                const origBytes = sess ? sess.origSize : meta ? meta.orig : null;
                // Compressed size: projected (this session) or already saved.
                const compBytes = sess
                  ? picked && sess.compressed && sess.compressed.size < sess.origSize
                    ? sess.compressed.size
                    : null
                  : meta && meta.size < meta.orig
                    ? meta.size
                    : null;
                return (
                  <div
                    className={"modal-image" + (isCover ? " is-cover" : "")}
                    key={fileName}
                    onClick={() => setAsCover(fileName)}
                    title={
                      isCover
                        ? "This is the card thumbnail"
                        : "Click to use as the card thumbnail"
                    }
                  >
                    <NoteImage fileName={fileName} className="modal-image-img" />
                    {isCover && <span className="cover-badge">Card thumbnail</span>}
                    {!isCover && <span className="set-cover-hint">Set as thumbnail</span>}
                    <button
                      type="button"
                      className="modal-image-remove"
                      title="Remove image"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImage(fileName);
                      }}
                    >
                      ✕
                    </button>
                    <div className="modal-image-sizes">
                      {sess && (
                        <label
                          className="img-compress"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={picked}
                            onChange={(e) => toggleImageCompress(fileName, e.target.checked)}
                          />
                          Compress
                        </label>
                      )}
                      <div className="img-rotate">
                        <button
                          type="button"
                          title="Rotate left"
                          onClick={(e) => {
                            e.stopPropagation();
                            rotateEditorImage(fileName, -90);
                          }}
                        >
                          ↺
                        </button>
                        <button
                          type="button"
                          title="Rotate right"
                          onClick={(e) => {
                            e.stopPropagation();
                            rotateEditorImage(fileName, 90);
                          }}
                        >
                          ↻
                        </button>
                      </div>
                      {origBytes != null && <span>Original: {fmtBytes(origBytes)}</span>}
                      {compBytes != null && <span>Compressed: {fmtBytes(compBytes)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="btn btn-ghost adjust-cover-btn"
              onClick={() => setShowCover(true)}
            >
              <span aria-hidden="true">◱</span> Adjust card thumbnail
            </button>
          </>
        )}
        {images.length === 0 && (
          <span className="modal-hint">Paste an image (Ctrl+V) to attach it</span>
        )}
        <div className="modal-field-row">
          <span className="label-caption">Label</span>
          <LabelDropdown
            labels={labels}
            currentLabel={label}
            onAssign={setLabel}
            onRename={onRenameLabel}
            direction="up"
          />
        </div>
        <div className="modal-actions">
          <button className="btn btn-danger" onClick={onDelete}>Delete</button>
          <button className="btn btn-ghost" onClick={onArchive}>Archive</button>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-accent"
            onClick={async () => {
              // Commit compression for the images the user ticked, then save.
              let finalImages = images;
              const finalMeta = { ...imageMeta };
              for (const fileName of images) {
                const sess = sessionImages.current.get(fileName);
                if (
                  sess &&
                  compressPick[fileName] &&
                  sess.compressed &&
                  sess.compressed.size < sess.origSize
                ) {
                  try {
                    const newName = `${uid()}.jpg`;
                    const newB64 = await blobToBase64(sess.compressed.blob);
                    await invoke("save_image", { fileName: newName, dataBase64: newB64 });
                    await invoke("delete_image", { fileName }).catch(() => {});
                    imageUrlCache.delete(fileName);
                    finalImages = finalImages.map((f) => (f === fileName ? newName : f));
                    finalMeta[newName] = { orig: sess.origSize, size: sess.compressed.size };
                    delete finalMeta[fileName];
                  } catch {
                    // keep the original on failure
                  }
                }
              }
              // Now that we're keeping the changes, drop the pre-rotation files.
              replacedOnSave.current.forEach((f) =>
                invoke("delete_image", { fileName: f }).catch(() => {})
              );
              replacedOnSave.current = [];
              onSave({
                ...card,
                title: title.trim(),
                body: body.trim(),
                label,
                images: finalImages,
                imageMeta: finalMeta,
                coverX,
                coverY,
                coverZoom,
              });
            }}
          >
            Save
          </button>
        </div>
      </div>
      {showCover && images.length > 0 && (
        <CoverAdjuster
          fileName={images[0]}
          initialX={coverX}
          initialY={coverY}
          initialZoom={coverZoom}
          onSave={(x, y, zoom) => {
            setCoverX(x);
            setCoverY(y);
            setCoverZoom(zoom);
            setShowCover(false);
          }}
          onClose={() => setShowCover(false)}
        />
      )}
    </div>
  );
}
