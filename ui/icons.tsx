import {
  ArrowRight,
  Bell,
  CalendarClock,
  ChartLine,
  Check,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  History,
  Info,
  KeyRound,
  LayoutDashboard,
  Link2,
  Linkedin,
  ListChecks,
  Loader2,
  LogOut,
  Mail,
  MailWarning,
  MessageCircle,
  PenLine,
  PlugZap,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  SearchX,
  Send,
  Settings2,
  Sheet,
  ShieldCheck,
  Sparkles,
  Table2,
  Timer,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Undo2,
  UserRound,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * THE icon set. Every icon in the product comes from this file and is exported
 * under a meaning, never a shape ("IconApprove", not "IconCheck"), so an icon can
 * never drift away from the thing it labels: change it here, everywhere follows.
 *
 * Named exports (not a map) keep the bundle tree-shaken: a page only ships the
 * icons it actually renders.
 */
export type IconComponent = LucideIcon;

/* brand + navigation */
export const IconBrand = Sparkles;
export const IconDashboard = LayoutDashboard;
export const IconQueue = CalendarClock;
export const IconPosts = FileText;
export const IconApprovals = CheckCheck;
export const IconHistory = History;
export const IconSettings = Settings2;
export const IconSearch = Search;
export const IconAdd = Plus;
export const IconNotifications = Bell;
export const IconSignOut = LogOut;
export const IconAccount = UserRound;

/* decisions */
export const IconApprove = Check;
export const IconReject = X;
export const IconClose = X;
export const IconUndo = Undo2;
export const IconPublish = Send;
export const IconSchedule = Timer;

/* content + AI */
export const IconAi = Sparkles;
export const IconGenerate = Wand2;
export const IconEdit = PenLine;
export const IconView = Eye;
export const IconCopy = Copy;
export const IconDownload = Download;
export const IconExternal = ExternalLink;
export const IconRefresh = RefreshCw;
export const IconFilter = Filter;
export const IconNext = ArrowRight;
export const IconMore = ListChecks;

/* integrations */
export const IconLinkedin = Linkedin;
export const IconMail = Mail;
export const IconMailWarning = MailWarning;
export const IconWhatsapp = MessageCircle;
export const IconSheets = Sheet;
export const IconSheetTable = Table2;
export const IconPlug = PlugZap;
export const IconKey = KeyRound;
export const IconSecurity = ShieldCheck;
export const IconLogs = ScrollText;
export const IconChart = ChartLine;
export const IconClock = Clock;

/* feedback */
export const IconSuccess = CircleCheck;
export const IconError = CircleAlert;
export const IconWarning = TriangleAlert;
export const IconInfo = Info;
export const IconSpinner = Loader2;
export const IconSearchEmpty = SearchX;
export const IconTrendUp = TrendingUp;
export const IconTrendDown = TrendingDown;

/* utility */
export const IconDelete = Trash2;
export const IconLink = Link2;
