import { Server } from "@server";
import path from "path";
import fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { isMinBigSur, isMinSequoia, isMinSonoma } from "@server/env";
import { checkPrivateApiStatus, waitMs } from "@server/helpers/utils";
import { quitFindMyFriends, startFindMyFriends, showFindMyFriends, hideFindMyFriends } from "../apple/scripts";
import { FindMyDevice, FindMyItem, FindMyLocationItem } from "@server/api/lib/findmy/types";
import { transformFindMyItemToDevice } from "@server/api/lib/findmy/utils";

export class FindMyInterface {
    static async getFriends(): Promise<FindMyLocationItem[]> {
        // Try to supplement the in-memory cache with data from the filesystem.
        // On macOS < 14.4, the friends cache file is unencrypted JSON.
        await FindMyInterface.loadFriendsFromFile();
        return Server().findMyCache.getAll();
    }

    static async getDevices(): Promise<Array<FindMyDevice> | null> {
        if (isMinSequoia) {
            Server().logger.debug('Cannot fetch FindMy devices on macOS Sequoia or later.');
            return null;
        }

        try {
            const [devices, items] = await Promise.all([
                FindMyInterface.readDataFile("Devices"),
                FindMyInterface.readDataFile("Items")
            ]);

            // Return null if neither of the files exist
            if (devices == null && items == null) return null;

            // Get any items with a group identifier
            const itemsWithGroup = items.filter(item => item.groupIdentifier);
            if (itemsWithGroup.length > 0) {
                try {
                    const itemGroups = await FindMyInterface.readItemGroups();
                    if (itemGroups) {
                        // Create a map of group IDs to group names
                        const groupMap = itemGroups.reduce((acc, group) => {
                            acc[group.identifier] = group.name;
                            return acc;
                        }, {} as Record<string, string>);

                        // Iterate over the items and add the group name
                        for (const item of items) {
                            if (item.groupIdentifier && groupMap[item.groupIdentifier]) {
                                item.groupName = groupMap[item.groupIdentifier];
                            }
                        }
                    }
                } catch (ex: any) {
                    Server().logger.debug('An error occurred while reading FindMy ItemGroups cache file.');
                    Server().logger.debug(String(ex));
                }
            }

            // Transform the items to match the same shape as devices
            const transformedItems = (items ?? []).map(transformFindMyItemToDevice);

            return [...(devices ?? []), ...transformedItems];
        } catch (ex: any) {
            Server().logger.debug('An error occurred while reading FindMy Device cache files.');
            Server().logger.debug(String(ex));
            return null;
        }
    }

    static async refreshDevices(): Promise<Array<FindMyDevice> | null> {
        // Can't use the Private API to refresh devices yet
        await this.refreshLocationsAccessibility();
        return await this.getDevices();
    }

    static async refreshFriends(openFindMyApp = true): Promise<FindMyLocationItem[]> {
        const papiEnabled = Server().repo.getConfig("enable_private_api") as boolean;
        if (papiEnabled && isMinBigSur && !isMinSonoma) {
            checkPrivateApiStatus();
            const result = await Server().privateApi.findmy.refreshFriends();
            const refreshLocations = result?.data?.locations ?? [];

            // Save the data to the cache
            // The cache will handle properly updating the data.
            Server().findMyCache.addAll(refreshLocations);
        }

        // Open the FindMy app to trigger a location refresh on macOS.
        // We must await so the app has time to fetch updated locations
        // before we read the cache files and return the response.
        if (openFindMyApp) {
            await this.refreshLocationsAccessibility();
        }

        // After the accessibility refresh, read any updated data from disk
        await FindMyInterface.loadFriendsFromFile();

        return Server().findMyCache.getAll();
    }

    static async refreshLocationsAccessibility() {
        await FileSystem.executeAppleScript(quitFindMyFriends());
        await waitMs(3000);

        // Make sure the Find My app is open.
        // Give it 5 seconds to open
        await FileSystem.executeAppleScript(startFindMyFriends());
        await waitMs(5000);

        // Bring the Find My app to the foreground so it refreshes the devices
        // Give it 15 seconds to refresh
        await FileSystem.executeAppleScript(showFindMyFriends());
        await waitMs(15000);

        // Re-hide the Find My App
        await FileSystem.executeAppleScript(hideFindMyFriends());
    }

    /**
     * Reads friend location data from the macOS FindMy cache file on disk
     * and loads it into the in-memory cache.
     *
     * On macOS < 14.4, the file at ~/Library/Caches/com.apple.findmy.fmfcore/FriendCacheData.data
     * is an unencrypted JSON array of friend records with location data.
     */
    static async loadFriendsFromFile(): Promise<void> {
        try {
            const friendCachePath = path.join(FileSystem.findMyFriendsCoreDir, "FriendCacheData.data");
            if (!fs.existsSync(friendCachePath)) return;

            const data = await fs.promises.readFile(friendCachePath, { encoding: "utf-8" });
            const parsedData = JSON.parse(data);
            if (!Array.isArray(parsedData)) return;

            const locationItems: FindMyLocationItem[] = [];
            for (const friend of parsedData) {
                // The friend cache file contains records with location data.
                // Extract what we need and transform into FindMyLocationItem format.
                const handle = friend?.handle ?? friend?.id ?? friend?.invitationFromHandles?.[0] ?? null;
                if (!handle) continue;

                const location = friend?.location ?? friend?.coordinates ?? null;
                if (!location) continue;

                const lat = location?.latitude ?? location?.[0] ?? 0;
                const lon = location?.longitude ?? location?.[1] ?? 0;

                const address = friend?.location?.address ?? friend?.address ?? null;
                const formattedAddress = address?.formattedAddressLines?.join(", ") ?? null;
                const shortAddress = address?.locality
                    ? `${address.locality}, ${address.administrativeArea ?? address.stateCode ?? ""}`
                    : null;

                const timestamp = location?.timestamp ?? location?.timeStamp ?? friend?.locationTimestamp ?? 0;

                locationItems.push({
                    handle,
                    coordinates: [lat, lon],
                    long_address: formattedAddress,
                    short_address: shortAddress,
                    subtitle: shortAddress,
                    title: friend?.firstName
                        ? `${friend.firstName}${friend.lastName ? " " + friend.lastName : ""}`
                        : handle,
                    last_updated: timestamp,
                    is_locating_in_progress: 0,
                    status: "legacy"
                });
            }

            if (locationItems.length > 0) {
                Server().findMyCache.addAll(locationItems);
            }
        } catch (ex: any) {
            Server().logger.debug('Failed to read FindMy friends cache file from disk.');
            Server().logger.debug(String(ex));
        }
    }

    static async readItemGroups(): Promise<Array<any>> {
        const itemGroupsPath = path.join(FileSystem.findMyDir, "ItemGroups.data");
        if (!fs.existsSync(itemGroupsPath)) return [];

        return new Promise((resolve, reject) => {
            fs.readFile(itemGroupsPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error("Failed to read FindMy ItemGroups cache file! It is not an array!"));
                    }
                } catch {
                    reject(new Error("Failed to read FindMy ItemGroups cache file! It is not in the correct format!"));
                }
            });
        });
    }

    private static readDataFile<T extends "Devices" | "Items">(
        type: T
    ): Promise<Array<T extends "Devices" ? FindMyDevice : FindMyItem> | null> {
        const devicesPath = path.join(FileSystem.findMyDir, `${type}.data`);
        return new Promise((resolve, reject) => {
            fs.readFile(devicesPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error(`Failed to read FindMy ${type} cache file! It is not an array!`));
                    }
                } catch {
                    reject(new Error(`Failed to read FindMy ${type} cache file! It is not in the correct format!`));
                }
            });
        });
    }
}
