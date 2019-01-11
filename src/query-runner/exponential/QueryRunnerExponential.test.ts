import "jest";
import LDFetch from "ldfetch";
import Context from "../../Context";
import ConnectionsFetcherLazy from "../../fetcher/connections/hydra/ConnectionsFetcherLazy";
import StopsFetcherLDFetch from "../../fetcher/stops/ld-fetch/StopsFetcherLDFetch";
import IPath from "../../interfaces/IPath";
import IStep from "../../interfaces/IStep";
import JourneyExtractorDefault from "../../planner/public-transport/JourneyExtractorDefault";
import PublicTransportPlannerCSAProfile from "../../planner/public-transport/PublicTransportPlannerCSAProfile";
import ReachableStopsFinderBirdsEyeCached from "../../planner/stops/ReachableStopsFinderBirdsEyeCached";
import TravelMode from "../../TravelMode";
import Units from "../../util/Units";
import LocationResolverDefault from "../LocationResolverDefault";
import QueryRunnerExponential from "./QueryRunnerExponential";

describe("[QueryRunnerExponential]", () => {
  jest.setTimeout(100000);

  let publicTransportResult;

  const query = {
    publicTransportOnly: true,
    from: "http://irail.be/stations/NMBS/008896925", // Ingelmunster
    to: "http://irail.be/stations/NMBS/008892007", // Ghent-Sint-Pieters
    minimumDepartureTime: new Date(),
    maximumTransferDuration: Units.fromHours(.5),
  };

  const createExponentialQueryRunner = () => {
    const ldFetch = new LDFetch({ headers: { Accept: "application/ld+json" } });

    const connectionFetcher = new ConnectionsFetcherLazy(ldFetch);
    connectionFetcher.setTravelMode(TravelMode.Train);
    connectionFetcher.setAccessUrl("https://graph.irail.be/sncb/connections");

    const stopsFetcher = new StopsFetcherLDFetch(ldFetch);
    stopsFetcher.setAccessUrl("https://irail.be/stations/NMBS");

    const locationResolver = new LocationResolverDefault(stopsFetcher);
    const reachableStopsFinder = new ReachableStopsFinderBirdsEyeCached(stopsFetcher);

    const context = new Context();

    const createJourneyExtractor = () => {
      return new JourneyExtractorDefault(
        locationResolver,
      );
    };

    const createPlanner = () => {
      return new PublicTransportPlannerCSAProfile(
        connectionFetcher,
        locationResolver,
        reachableStopsFinder,
        reachableStopsFinder,
        reachableStopsFinder,
        createJourneyExtractor(),
      );
    };

    return new QueryRunnerExponential(context, locationResolver, createPlanner);
  };

  const result: IPath[] = [];

  beforeAll(async (done) => {

    const queryRunner = createExponentialQueryRunner();

    publicTransportResult = await queryRunner.run(query);

    await publicTransportResult.take(3)
      .on("data", (path: IPath) => {
        result.push(path);
      })
      .on("end", () => {
        done();
      });
  });

  it("Correct departure and arrival stop", () => {
    checkStops(result, query);
  });
});

const checkStops = (result, query) => {
  expect(result).toBeDefined();
  expect(result.length).toBeGreaterThanOrEqual(1);

  for (const path of result) {
    expect(path.steps).toBeDefined();

    expect(path.steps.length).toBeGreaterThanOrEqual(1);

    let currentLocation = query.from;
    path.steps.forEach((step: IStep) => {
      expect(step).toBeDefined();
      expect(currentLocation).toEqual(step.startLocation.id);
      currentLocation = step.stopLocation.id;
    });

    expect(query.to).toEqual(currentLocation);
  }
};
