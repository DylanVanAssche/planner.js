import { ArrayIterator, AsyncIterator } from "asynciterator";
import { EventEmitter } from "events";
import { inject, injectable, tagged } from "inversify";
import inBBox from "tiles-in-bbox";
import Profile from "../../entities/profile/Profile";
import { RoutableTileCoordinate } from "../../entities/tiles/coordinate";
import { RoutableTileNode } from "../../entities/tiles/node";
import RoutableTileRegistry from "../../entities/tiles/registry";
import { RoutableTile } from "../../entities/tiles/tile";
import RoutingPhase from "../../enums/RoutingPhase";
import TravelMode from "../../enums/TravelMode";
import EventBus from "../../events/EventBus";
import EventType from "../../events/EventType";
import IProfileProvider from "../../fetcher/profiles/IProfileProvider";
import IRoutableTileProvider from "../../fetcher/tiles/IRoutableTileProvider";
import ILocation from "../../interfaces/ILocation";
import IPath from "../../interfaces/IPath";
import IStep from "../../interfaces/IStep";
import PathfinderProvider from "../../pathfinding/PathfinderProvider";
import ILocationResolver from "../../query-runner/ILocationResolver";
import IResolvedQuery from "../../query-runner/IResolvedQuery";
import TYPES from "../../types";
import Geo from "../../util/Geo";
import { toTileCoordinate } from "../../util/Tiles";
import Leg from "../Leg";
import Path from "../Path";
import IRoadPlanner from "./IRoadPlanner";

@injectable()
export default class RoadPlannerPathfindingExperimental implements IRoadPlanner {
    private baseTileProvider: IRoutableTileProvider;
    private transitTileProvider: IRoutableTileProvider;
    private pathfinderProvider: PathfinderProvider;
    private profileProvider: IProfileProvider;
    private locationResolver: ILocationResolver;
    private registry: RoutableTileRegistry;
    private eventBus: EventEmitter;

    // STATEFUL!
    // will misbehave when processing several queries concurrently
    private reachedTiles: Set<string>;
    private localTiles: RoutableTileCoordinate[];

    constructor(
        @inject(TYPES.RoutableTileProvider)
        @tagged("phase", RoutingPhase.Base)
        baseTileProvider: IRoutableTileProvider,
        @inject(TYPES.RoutableTileProvider)
        @tagged("phase", RoutingPhase.Transit)
        transitTileProvider: IRoutableTileProvider,
        @inject(TYPES.PathfinderProvider) pathfinderProvider: PathfinderProvider,
        @inject(TYPES.ProfileProvider) profileProvider: IProfileProvider,
        @inject(TYPES.LocationResolver) locationResolver: ILocationResolver,
        @inject(TYPES.RoutableTileRegistry) registry: RoutableTileRegistry,
    ) {
        this.baseTileProvider = baseTileProvider;
        this.transitTileProvider = transitTileProvider;
        this.pathfinderProvider = pathfinderProvider;
        this.profileProvider = profileProvider;
        this.locationResolver = locationResolver;
        this.registry = registry;
        this.eventBus = EventBus.getInstance();
        this.reachedTiles = new Set();
    }

    public async plan(query: IResolvedQuery): Promise<AsyncIterator<IPath>> {
        const {
            from: fromLocations,
            to: toLocations,
            profileID,
        } = query;

        const paths = [];
        const profile = await this.profileProvider.getProfile(profileID);

        if (fromLocations && toLocations && fromLocations.length && toLocations.length) {

            for (const from of fromLocations) {
                for (const to of toLocations) {

                    const newPath = await this.getPathBetweenLocations(
                        from,
                        to,
                        profile,
                    );

                    if (newPath) {
                        paths.push(newPath);
                    }
                }
            }
        }

        return new ArrayIterator<IPath>(paths);
    }

    private async getPathBetweenLocations(
        from: ILocation,
        to: ILocation,
        profile: Profile,
    ): Promise<IPath> {
        this.localTiles = [
            toTileCoordinate(from.latitude, from.longitude),
            toTileCoordinate(to.latitude, to.longitude),
        ];

        await Promise.all([
            this.embedLocation(from),
            this.embedLocation(to, true),
        ]);

        return this._innerPath(from, to, profile);
    }

    private async _innerPath(
        start: ILocation,
        stop: ILocation,
        profile: Profile,
    ): Promise<IPath> {
        const pathfinder = await this.pathfinderProvider.getShortestPathAlgorithm(profile);
        const maxDistance = Geo.getDistanceBetweenLocations(start, stop) * 5;
        const path = await pathfinder.queryPath(Geo.getId(start), Geo.getId(stop), maxDistance);

        const steps: IStep[] = [];
        for (const step of path) {
            const to = await this.locationResolver.resolve(step.to);
            const from = await this.locationResolver.resolve(step.from);
            steps.push({
                startLocation: from,
                stopLocation: to,
                duration: { average: step.duration },
                distance: step.distance,
            });
        }

        const leg = new Leg(TravelMode.Profile, steps);
        return new Path([leg]);
    }

    private pickTile(node: RoutableTileNode) {
        let coordinate: RoutableTileCoordinate;
        for (let zoom = 8; zoom < 15; zoom++) {
            coordinate = toTileCoordinate(node.latitude, node.longitude, zoom);
            let ok = true;
            for (const localTile of this.localTiles) {
                if (coordinate.contains(localTile)) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                return coordinate;
            }
        }
        return coordinate;
    }

    private async fetchTile(coordinate: RoutableTileCoordinate) {
        let local = false;
        for (const localTile of this.localTiles) {
            if (coordinate.x === localTile.x && coordinate.y === localTile.y && coordinate.zoom === localTile.zoom) {
                local = true;
                break;
            }
        }

        const baseTileId = this.baseTileProvider.getIdForTileCoords(coordinate);
        const transitTileId = this.transitTileProvider.getIdForTileCoords(coordinate);

        if (!this.reachedTiles.has(transitTileId) && !this.reachedTiles.has(baseTileId)) {
            this.eventBus.emit(EventType.FetchTile, coordinate);
            let tile: RoutableTile;
            if (local) {
                tile = await this.baseTileProvider.getByTileCoords(coordinate);
                this.reachedTiles.add(baseTileId);
                this.reachedTiles.add(transitTileId);
            } else {
                tile = await this.transitTileProvider.getByTileCoords(coordinate);
                this.reachedTiles.add(transitTileId);
            }
            const boundaryNodes: Set<string> = new Set();

            for (const nodeId of tile.getNodes()) {
                const node = this.registry.getNode(nodeId);
                if (!tile.contains(node)) {
                    boundaryNodes.add(nodeId);
                }
            }

            const self = this;
            for (const profile of await this.profileProvider.getProfiles()) {
                const graph = this.pathfinderProvider.getGraphForProfile(profile);

                for (const nodeId of boundaryNodes) {
                    graph.setBreakPoint(nodeId, async (on: string) => {
                        const node = self.registry.getNode(on);
                        const boundaryTileCoordinate = this.pickTile(node);
                        await self.fetchTile(boundaryTileCoordinate);
                    });
                }
            }
        }
    }

    private async embedLocation(from: ILocation, invert = false) {
        const zoom = 14;
        const padding = 0.005;

        const fromBBox = {
            top: from.latitude + padding,
            bottom: from.latitude - padding,
            left: from.longitude - padding,
            right: from.longitude + padding,
        };

        const fromTileCoords = inBBox.tilesInBbox(fromBBox, zoom).map((obj) => {
            const coordinate = new RoutableTileCoordinate(zoom, obj.x, obj.y);
            this.fetchTile(coordinate);
            return coordinate;
        });

        // this won't download anything new
        // but we need the tile data to embed the starting location
        const fromTileset = await this.baseTileProvider.getMultipleByTileCoords(fromTileCoords);
        await this.pathfinderProvider.embedLocation(from, fromTileset, invert);
    }
}
