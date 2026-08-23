import {
    acceptGroupInvitation,
    declineGroupInvitation,
    dismissNotification,
    getMyNotifications,
    markNotificationsRead,
} from '@/utils/api';
import {
    createContext,
    ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { useAuth } from './AuthContext';

// 1. Define the shape of the data and functions in our context
interface NotificationContextType {
    notifications: any[]; // TODO: Create a proper Notification type
    notificationCount: number;
    isLoading: boolean;
    fetchNotifications: () => Promise<void>;
    markAllRead: () => Promise<void>;
    acceptInvitation: (invitationId: string, onSuccess?: () => void) => Promise<void>;
    declineInvitation: (invitationId: string) => Promise<void>;
}

// 2. Create the context with a default undefined value
const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

// 3. Create the Provider component
export const NotificationProvider = ({ children }: { children: ReactNode }) => {
    const { user } = useAuth();
    const [notifications, setNotifications] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const fetchNotifications = useCallback(async () => {
        if (!user || user.isAnonymous) {
            setNotifications([]); // Clear notifications for logged-out users
            return;
        };
        setIsLoading(true);
        try {
            const notifs = await getMyNotifications();
            setNotifications(notifs);
        } catch (error) {
            console.error("Failed to fetch notifications in context:", error);
            setNotifications([]);
        } finally {
            setIsLoading(false);
        }
    }, [user]);

    // Fetch notifications whenever the user object changes (e.g., on login/logout)
    useEffect(() => {
        fetchNotifications();
    }, [fetchNotifications]);

    /**
     * Clears the badge. Called when the user opens the notifications list: the
     * items stay on screen for the rest of that session (marking read must not
     * empty the list out from under them), but they count as seen, and the next
     * fetch drops them because the list endpoint only returns unread ones.
     */
    const markAllRead = useCallback(async () => {
        // Nothing unread means nothing to write — opening the modal repeatedly
        // should not fire a request each time.
        const wasUnread = new Set(notifications.filter(n => !n.read).map(n => n.id));
        if (wasUnread.size === 0) return;
        // Optimistic: the badge should go away on tap, not after a round trip.
        setNotifications(prev => prev.map(n => (n.read ? n : { ...n, read: true })));
        try {
            await markNotificationsRead();
        } catch (error) {
            console.error("Failed to mark notifications read:", error);
            // Put the badge back so it still reflects the server — but only for
            // the ones this call touched, not any read earlier and successfully.
            setNotifications(prev =>
                prev.map(n => (wasUnread.has(n.id) ? { ...n, read: false } : n)),
            );
        }
    }, [notifications]);

    const acceptInvitation = async (invitationId: string, onSuccess?: () => void) => {
        try {
            await acceptGroupInvitation(invitationId);
            // Optimistically update UI for a faster feel
            setNotifications(prev => prev.filter(n => n.id !== invitationId));
            onSuccess?.(); // Optional success callback for things like navigation
        } catch (error) {
            console.error("Failed to accept invitation:", error);
        }
    };

    const declineInvitation = async (invitationId: string) => {
        try {
            await declineGroupInvitation(invitationId);
            setNotifications(prev => prev.filter(n => n.id !== invitationId));
        } catch (error) {
            console.error("Failed to decline invitation:", error);
        }
    };

    const dismiss = async (notificationId: string) => {
        await dismissNotification(notificationId);
        setNotifications(prev => prev.filter(n => n.id !== notificationId));
    };

    // Unread only: read notifications stay in the list for the current session
    // but must not keep the badge lit.
    const notificationCount = useMemo(
        () => notifications.filter(n => !n.read).length,
        [notifications],
    );

    const value = {
        notifications,
        notificationCount,
        isLoading,
        fetchNotifications,
        markAllRead,
        acceptInvitation,
        declineInvitation,
    };

    return (
        <NotificationContext.Provider value={value}>
            {children}
        </NotificationContext.Provider>
    );
};

// 4. Create a custom hook for easy access to the context
export const useNotifications = () => {
    const context = useContext(NotificationContext);
    if (context === undefined) {
        throw new Error('useNotifications must be used within a NotificationProvider');
    }
    return context;
};