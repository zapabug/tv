import 'websocket-polyfill'; // Keep polyfill for now, though likely not needed for NDK
import React, { useState, useEffect, useRef, useCallback } from 'react';
import NDK, { NDKEvent, NDKFilter, NDKKind, NDKSubscription, NDKUserProfile } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools'; // Import nip19 for decoding
// Import shared profile cache utilities
import { 
    ProfileData, 
    getProfileFromCache, 
    saveProfileToCache,
    getAllProfilesFromCache, // Keep if using initial bulk load
    deleteExpiredProfilesFromCache, // Keep if using cleanup
    parseProfileContent
} from '../utils/profileCache';

// Define the props for the component
interface MessageBoardProps {
  ndk: NDK | null;
  neventToFollow: string;
  authors: string[]; // Add authors prop
}

const MessageBoard: React.FC<MessageBoardProps> = ({ ndk, neventToFollow, authors }) => {
  const [messages, setMessages] = useState<NDKEvent[]>([]);
  const [targetEventId, setTargetEventId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProfileData>>({}); // State for profiles (uses imported type)
  const subscription = useRef<NDKSubscription | null>(null);
  const processingPubkeys = useRef<Set<string>>(new Set()); // Track profiles being fetched
  const [isProfileCacheLoaded, setIsProfileCacheLoaded] = useState(false);

  // Load profiles from shared cache on component mount
  useEffect(() => {
    getAllProfilesFromCache() // Use imported function
      .then(cachedProfiles => {
        console.log(`MessageBoard: Loaded ${cachedProfiles.length} profiles from shared cache.`);
        const cachedProfilesMap: Record<string, ProfileData> = {};
        cachedProfiles.forEach(profile => {
          // Ensure profile and pubkey exist before adding
          if (profile && profile.pubkey) { 
              cachedProfilesMap[profile.pubkey] = { ...profile, isLoading: false };
          }
        });
        setProfiles(cachedProfilesMap);
        setIsProfileCacheLoaded(true);
        // Optional: Trigger cleanup of expired profiles
        // deleteExpiredProfilesFromCache().catch(err => console.error('MessageBoard: Failed background cache cleanup:', err));
      })
      .catch(err => {
        console.error('MessageBoard: Failed to load profiles from shared cache:', err);
        setIsProfileCacheLoaded(true);
      });
  }, []); // Run once on mount

  // Effect to decode the nevent URI
  useEffect(() => {
    if (!neventToFollow) {
      console.error('MessageBoard: neventToFollow prop is missing.');
      setTargetEventId(null);
      return;
    }
    try {
      // Remove "nostr:" prefix if present before decoding
      const cleanNevent = neventToFollow.startsWith('nostr:') 
        ? neventToFollow.substring(6) 
        : neventToFollow;
        
      const decoded = nip19.decode(cleanNevent); // Decode the cleaned string
      if (decoded.type !== 'nevent' || !decoded.data.id) {
        console.error('MessageBoard: Failed to decode nevent or extract ID:', cleanNevent);
        setTargetEventId(null);
      } else {
        console.log('MessageBoard: Decoded nevent ID:', decoded.data.id);
        setTargetEventId(decoded.data.id);
      }
    } catch (error) {
      console.error('MessageBoard: Error decoding nevent:', neventToFollow, error);
      setTargetEventId(null);
    }
  }, [neventToFollow]);

  // Effect to subscribe when NDK and targetEventId are available
  useEffect(() => {
    // Only proceed if we have NDK and a valid target event ID
    if (!ndk || !targetEventId) {
      console.log('MessageBoard: Waiting for NDK and/or targetEventId.');
      setMessages([]); // Clear messages
      setProfiles({}); // Clear profiles too
      // Ensure any previous subscription is stopped if targetEventId becomes invalid
      if (subscription.current) {
          subscription.current.stop();
          subscription.current = null;
      }
      return;
    }

    // Assuming the passed NDK instance handles its connection lifecycle.
    console.log(`MessageBoard: NDK ready, subscribing to replies for event ${targetEventId} from ${authors.length} authors...`);
    subscribeToReplies(ndk, targetEventId, authors);

    // Cleanup function
    return () => {
      console.log('MessageBoard: Cleaning up replies subscription...');
      if (subscription.current) {
        subscription.current.stop();
        subscription.current = null;
      }
      setMessages([]);
      setProfiles({}); // Clear profiles on cleanup
      processingPubkeys.current.clear(); // Clear processing set
    };
    // Re-run the effect if ndk, targetEventId, or authors changes
  }, [ndk, targetEventId, authors]);

  // --- Function to fetch profiles, wrapped in useCallback ---
  const fetchProfile = useCallback(async (pubkey: string) => {
    if (!ndk || profiles[pubkey]?.name || processingPubkeys.current.has(pubkey)) {
      return;
    }

    try {
      const cachedProfile = await getProfileFromCache(pubkey); // Use imported function
      if (cachedProfile && cachedProfile.name) { // Check cached profile validity
        console.log(`MessageBoard: Using cached profile for ${pubkey.substring(0, 8)}.`);
        setProfiles(prev => ({ 
          ...prev, 
          [pubkey]: { ...cachedProfile, isLoading: false } // Spread cached data
        }));
        return;
      }
    } catch (err) {
      console.error(`MessageBoard: Error checking shared cache for ${pubkey.substring(0, 8)}:`, err);
    }

    console.log(`MessageBoard: Fetching profile for ${pubkey.substring(0, 8)}...`);
    processingPubkeys.current.add(pubkey); 
    setProfiles(prev => ({ ...prev, [pubkey]: { ...prev[pubkey], pubkey: pubkey, isLoading: true } }));

    try {
      const user = ndk.getUser({ pubkey });
      const profileEvent = await user.fetchProfile();
      
      if (profileEvent && typeof profileEvent.content === 'string') {
        const parsedProfileData = parseProfileContent(profileEvent.content, pubkey); // Use shared parser
        
        if (parsedProfileData) {
            setProfiles(prev => ({ 
              ...prev, 
              [pubkey]: { ...parsedProfileData, isLoading: false }
            }));
            // Save to shared cache
            saveProfileToCache({ ...parsedProfileData, pubkey }).catch(err => 
                console.error(`MessageBoard: Failed to save profile to shared cache for ${pubkey.substring(0, 8)}:`, err)
            );
        } else {
             // Handle parsing error - already logged in parseProfileContent
             setProfiles(prev => ({ ...prev, [pubkey]: { ...prev[pubkey], pubkey: pubkey, isLoading: false } }));
        }

      } else {
        console.log(`MessageBoard: No profile or invalid content found for ${pubkey.substring(0,8)}.`);
        setProfiles(prev => ({ ...prev, [pubkey]: { ...prev[pubkey], pubkey: pubkey, isLoading: false } }));
      }
    } catch (error) {
      console.error(`MessageBoard: Error fetching profile for ${pubkey}:`, error);
      setProfiles(prev => ({ ...prev, [pubkey]: { ...prev[pubkey], pubkey: pubkey, isLoading: false } }));
    } finally {
        processingPubkeys.current.delete(pubkey);
    }
  }, [ndk]); // Removed profiles dependency

  // --- Effect to trigger profile fetches and subscriptions when messages update ---
  useEffect(() => {
    if (!ndk || !isProfileCacheLoaded) return; // Wait for cache load
    const authorsToFetch = new Set<string>();
    const authorsToSubscribe = new Set<string>();
    messages.forEach(msg => {
        if (!profiles[msg.pubkey]?.name && !processingPubkeys.current.has(msg.pubkey)) {
            authorsToFetch.add(msg.pubkey);
        }
        authorsToSubscribe.add(msg.pubkey);
    });
    authorsToFetch.forEach(pubkey => fetchProfile(pubkey));

    let authorsProfileSub: NDKSubscription | null = null;
    if (authorsToSubscribe.size > 0) {
      const authorsArray = Array.from(authorsToSubscribe);
      const profileFilter: NDKFilter = { kinds: [NDKKind.Metadata], authors: authorsArray, limit: authorsArray.length };
      console.log('MessageBoard: Subscribing to message authors profile updates.');
      authorsProfileSub = ndk.subscribe(profileFilter, { closeOnEose: false });
      
      authorsProfileSub.on('event', (profileEvent: NDKEvent) => {
        const eventPubkey = profileEvent?.pubkey;
        if (!eventPubkey || typeof eventPubkey !== 'string') return;

        console.log(`MessageBoard: Received author profile update for ${eventPubkey.substring(0, 8)}.`);
        if (profileEvent.content && typeof profileEvent.content === 'string') {
            const parsedProfileData = parseProfileContent(profileEvent.content, eventPubkey);
            if (parsedProfileData) {
                 setProfiles(prev => {
                  const existingProfile = prev[eventPubkey];
                  // Prioritize incoming picture if it exists, otherwise keep existing picture
                  const pictureToSet = parsedProfileData.picture !== undefined ? parsedProfileData.picture : existingProfile?.picture;
                  // Merge name: Use new if available, else existing
                  const nameToSet = parsedProfileData.name !== undefined ? parsedProfileData.name : existingProfile?.name;
                  
                  // Create the updated profile object by merging
                  const updatedProfile = { 
                        ...existingProfile, // Start with existing 
                        ...parsedProfileData, // Overwrite with parsed fields
                        name: nameToSet, // Apply specific merge logic
                        picture: pictureToSet, // Apply specific merge logic
                        isLoading: false 
                    };

                  return { ...prev, [eventPubkey]: updatedProfile };
                });
                 // Save updated profile to cache
                saveProfileToCache({ ...parsedProfileData, pubkey: eventPubkey }).catch(err => 
                    console.error(`MessageBoard: Failed to save updated profile to shared cache for ${eventPubkey.substring(0, 8)}:`, err)
                 );
            }
        }
      });
      authorsProfileSub.on('eose', () => { /* console.log('EOSE...') */ });
      authorsProfileSub.start();
    }
    return () => {
        authorsProfileSub?.stop();
      };
  }, [messages, ndk, fetchProfile, isProfileCacheLoaded]); // Added isProfileCacheLoaded dependency

  const subscribeToReplies = (ndkInstance: NDK, eventId: string, authorsToFilter: string[]) => {
    // Prevent duplicate subscriptions
    if (subscription.current) {
      subscription.current.stop();
    }

    // Filter for kind 1 notes that tag the target event ID
    const filter: NDKFilter = {
      kinds: [NDKKind.Text],
      '#e': [eventId],
      authors: authorsToFilter, // Use authors prop in filter
      limit: 50,
    };

    console.log('NDK subscribing with reply filter:', filter);
    subscription.current = ndkInstance.subscribe(
        filter,
        { closeOnEose: false }
    );

    subscription.current.on('event', (event: NDKEvent) => {
        setMessages((prevMessages) => {
            if (prevMessages.some(msg => msg.id === event.id)) {
                return prevMessages;
            }
            // Prepend new message for chronological order (newest first)
            const newMessages = [event, ...prevMessages]; 
            // Optionally trim the list if it gets too long
            // if (newMessages.length > 100) newMessages.length = 100;
            return newMessages;
        });
    });

    subscription.current.on('eose', () => {
        console.log(`NDK EOSE received for replies to ${eventId}`);
    });

    subscription.current.start();
  };

  // Simplified status rendering
  const renderStatus = () => {
      if (!ndk) return 'Waiting for NDK...';
      if (!targetEventId) return 'Invalid or missing nevent to follow.';
      if (messages.length === 0) return 'Loading replies or none found...';
      return null;
  }

  return (
    <div className="bg-black shadow-2xl box-border overflow-hidden p-4 lg:p-6 flex flex-col items-center w-full">
      {messages.length === 0 && !renderStatus() && (
          <p className="text-gray-500 text-center mt-6 text-lg lg:text-xl">No replies yet...</p>
      )}

      {messages.length > 0 && (
        <ul className="space-y-2 w-full max-w-lg lg:max-w-3xl xl:max-w-4xl my-4 lg:my-6 pl-20">
          {messages.map((msg) => {
              const profile = profiles[msg.pubkey];
              const displayName = profile?.name || profile?.displayName || msg.pubkey.substring(0, 10) + '...'; // Use displayName as fallback
              const pictureUrl = profile?.picture;
              const isLoadingProfile = profile?.isLoading;

              return (
                <li key={msg.id} className="flex flex-row items-start space-x-2 py-1 lg:py-2 bg-gray-900 bg-opacity-50 rounded-lg px-3 lg:px-4 shadow-md">
                  <div className="flex-shrink-0 w-10 h-10 lg:w-12 lg:h-12 rounded-full bg-gray-600 overflow-hidden mt-1 lg:mt-2">
                      {isLoadingProfile ? (
                          <div className="w-full h-full animate-pulse bg-gray-500"></div>
                      ) : pictureUrl ? (
                          <img src={pictureUrl} alt={displayName} className="w-full h-full object-cover" onError={() => console.error(`MessageBoard: Failed to load image for ${displayName} at ${pictureUrl}`)} />
                      ) : (
                          <span className="text-gray-300 text-xs lg:text-sm font-semibold flex items-center justify-center h-full uppercase">
                              {displayName.substring(0, 2)}
                          </span>
                      )}
                  </div>
                  <div className="flex-grow min-w-0 mt-1 lg:mt-2">
                      <span className="font-medium text-gray-200 text-sm lg:text-base mr-2" title={profile?.name ? msg.pubkey : undefined}>
                          {displayName}:
                      </span>
                      <span className="text-sm lg:text-base text-gray-300 break-words">
                          {msg.content}
                      </span>
                  </div>
                </li>
              );
          })}
        </ul>
      )}
    </div>
  );
};

export default MessageBoard; 