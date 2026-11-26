# Core types

Parsers build these values where Elexon or NESO data enters the process. Later code trusts them. Money types are estimates. This page is the contract for the implementation plan.

## Branded scalars

A brand is a TypeScript intersection with a unique tag. The parser returns it after a check. Call sites do not cast.

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };

type Instant = Brand<string, "Instant">;
type SettlementDate = Brand<string, "SettlementDate">;
type PeriodIndex = Brand<number, "PeriodIndex">;
type ElexonBmUnitId = Brand<string, "ElexonBmUnitId">;
type NationalGridBmUnitId = Brand<string, "NationalGridBmUnitId">;
type Megawatt = Brand<number, "Megawatt">;
type SignedMwh = Brand<number, "SignedMwh">;
type NonPositiveMwh = Brand<number, "NonPositiveMwh">;
type NonNegativeMwh = Brand<number, "NonNegativeMwh">;
type GbpPerMwh = Brand<number, "GbpPerMwh">;
type GbpEstimate = Brand<number, "GbpEstimate">;
type AcceptanceId = Brand<number, "AcceptanceId">;
type ConstraintGroupName = Brand<string, "ConstraintGroupName">;
```

`SettlementDate` is `YYYY-MM-DD` in the Europe/London settlement calendar. `Instant` is an ISO-8601 UTC timestamp. `AcceptanceId` is the Elexon acceptance number. `NonPositiveMwh` is a bid volume. The parser rejects a positive number for that brand.

## Settlement period

Period 1 starts at local midnight. Each period is 30 minutes. A normal day has 48 periods. A spring-forward day has 46. A clock-back day has 50. The day owns that count. A period does not repeat it.

```ts
type SettlementDay = {
	readonly date: SettlementDate;
	readonly periodsInDay: 46 | 48 | 50;
};

type SettlementPeriod = {
	readonly day: SettlementDay;
	readonly index: PeriodIndex;
	readonly durationMinutes: 30;
};
```

The throwaway spike refuses 46-period and 50-period days. The plan's volume PR keeps that refusal until a clock-change fixture exists.

## BM unit and the proxy

```ts
type GspGroupId = "_N" | "_P" | Brand<string, "OtherGsp">;

type BmUnit = {
	readonly elexonId: ElexonBmUnitId;
	readonly nationalGridId: NationalGridBmUnitId;
	readonly gspGroupId: GspGroupId;
	readonly fuelType: string | null;
	readonly name: string;
};

type MaxDeliveryKind = "MDO" | "MDB";

type MaxDeliverySubmission = {
	readonly unit: ElexonBmUnitId;
	readonly kind: MaxDeliveryKind;
	readonly day: SettlementDate;
};

type ConstraintUnitProxy = {
	readonly kind: "constraintUnitProxy";
	readonly unit: BmUnit;
	readonly gspGroupId: "_N" | "_P";
	readonly submitted: "MDO" | "MDB" | "both";
};
```

`ConstraintUnitProxy` means the unit submitted MDO or MDB, sits in GSP `_N` or `_P`, and has at least one system bid on the day being selected. It is not an official map from BM units to constraints. `selectProxyUnits` is the only constructor.

## Acceptance and published volume

```ts
type MwPoint = { readonly at: Instant; readonly mw: Megawatt };

type Acceptance = {
	readonly id: AcceptanceId;
	readonly acceptedAt: Instant;
	readonly so: boolean;
	readonly stor: boolean;
	readonly rr: boolean;
	readonly deemed: boolean;
	readonly amended: boolean;
	readonly profile: readonly [MwPoint, MwPoint, ...MwPoint[]];
};

type SystemBid = {
	readonly kind: "systemBid";
	readonly acceptanceId: AcceptanceId;
	readonly acceptedAt: Instant;
	readonly unit: ElexonBmUnitId;
	readonly period: SettlementPeriod;
	readonly volumeMwh: NonPositiveMwh;
};

type ComputedBidVolume = {
	readonly acceptanceId: AcceptanceId;
	readonly period: SettlementPeriod;
	readonly volumeMwh: SignedMwh;
};

type PublishedBidVolume = {
	readonly source: "BOAV.totalVolumeAccepted";
	readonly acceptanceId: AcceptanceId;
	readonly period: SettlementPeriod;
	readonly volumeMwh: SignedMwh;
};
```

Settled volume for one acceptance in one period is the integral of this acceptance's level minus the previous operative level. The previous level is the latest earlier acceptance that covers that instant, otherwise the final physical notification. Bid megawatt-hours are negative. `PublishedBidVolume` is the Elexon BOAV figure for the same acceptance and period. The volume function's check is those two numbers.

## Physical notifications

```ts
type PublicPn = {
	readonly kind: "publicPn";
	readonly unit: ElexonBmUnitId;
	readonly points: readonly [MwPoint, ...MwPoint[]];
};

type TimestampedFpnRise = {
	readonly kind: "timestampedFpnRise";
	readonly unit: ElexonBmUnitId;
	readonly submittedAt: Instant;
	readonly points: readonly [MwPoint, ...MwPoint[]];
	readonly riseMw: Megawatt;
};
```

The public PN payload has level points and no submission timestamp. `TimestampedFpnRise` exists only when a source provides `submittedAt` and the change is an increase. The current Elexon physical endpoint does not provide `submittedAt`.

## Constraint half-hour

```ts
type DayAheadConstraintHalfHour = {
	readonly group: ConstraintGroupName;
	readonly at: Instant;
	readonly limitMw: Megawatt;
	readonly flowMw: Megawatt;
};

type MarkedMembership = {
	readonly unit: ElexonBmUnitId;
	readonly group: ConstraintGroupName;
	readonly role: "storage" | "nonStorage";
};
```

A day-ahead row has a constraint group, a time, a limit, and a flow. It has no BM unit list. Nothing in this type treats flow against limit as "the constraint is active". Membership is marked by a person, or it is absent.

## Loop finding

```ts
type LoopFinding =
	| {
			readonly kind: "confirmed";
			readonly bid: SystemBid;
			readonly fpn: TimestampedFpnRise;
			readonly further: SystemBid;
	  }
	| {
			readonly kind: "pnWithoutFurtherAction";
			readonly bid: SystemBid;
			readonly fpn: TimestampedFpnRise;
	  }
	| {
			readonly kind: "unconfirmed";
			readonly reason: "noPnSubmissionTimestamp";
			readonly bid: SystemBid;
	  };
```

A confirmed loop is a system bid, then a positive FPN change submitted after that bid, then a further system bid. `pnWithoutFurtherAction` is the extra PN that NESO does not cost. `unconfirmed` is the public-data result. It is not a loop.

## Cost estimates

```ts
type SystemBidCostEstimate = {
	readonly kind: "systemBidCostEstimate";
	readonly bid: SystemBid;
	readonly bidComponentGbp: GbpEstimate;
	readonly replacementGbp: GbpEstimate;
	readonly netGbp: GbpEstimate;
};

type MissingOfferPrice = {
	readonly kind: "missingOfferPrice";
	readonly period: SettlementPeriod;
};

type LoopCostEstimate = {
	readonly kind: "loopCostEstimate";
	readonly finding: Extract<LoopFinding, { kind: "confirmed" }>;
	readonly netGbp: GbpEstimate;
};
```

`priceSystemBid` prices one system bid. The bid component is the sum of bid price times signed pair volume. Replacement is the volume magnitude times the megawatt-hour-weighted average price of accepted offers in that settlement period. Net is the sum. The NESO appendix describes the bid term as a negative cost that offsets replacement. This estimate follows that reading.

`attributeLoopCost` accepts only `kind: "confirmed"`. It does not accept `unconfirmed` or `pnWithoutFurtherAction`.

## Ancillary flag

```ts
type NegativeService = "dcLow" | "dmLow" | "drLow" | "negativeQuickReserve";

type AncillaryFlag =
	| { readonly kind: "unknown"; readonly reason: "publicDataGap" }
	| { readonly kind: "held"; readonly service: NegativeService }
	| { readonly kind: "notHeld" };
```

The MVP can only produce `unknown`. Auction result files are not a unit's negative contract for the next 3 hours.

## Counterfactual

```ts
type Rule3A = { readonly kind: "3A" };

type Counterfactual3A =
	| { readonly kind: "notApplied"; readonly reason: "noMarkedNonStorageActions" }
	| {
			readonly kind: "replayed";
			readonly observedGbp: GbpEstimate;
			readonly replayedGbp: GbpEstimate;
			readonly deltaGbp: GbpEstimate;
	  };
```

Rule 3A means non-storage actions before storage actions in the marked set. `notApplied` means the marked set has no non-storage action, so there is no delta. A zero `deltaGbp` exists only on `replayed`, after the reorder has run.

Rules 3AA and 3AA Max are not in this contract.

## Functions

```ts
function selectProxyUnits(input: {
	readonly units: readonly BmUnit[];
	readonly submissions: readonly MaxDeliverySubmission[];
	readonly systemBids: readonly SystemBid[];
}): readonly ConstraintUnitProxy[];

function settleBidVolume(input: {
	readonly acceptances: readonly Acceptance[];
	readonly publicPn: PublicPn;
	readonly period: SettlementPeriod;
}): readonly ComputedBidVolume[];

function detectLoops(input: {
	readonly bids: readonly SystemBid[];
	readonly publicPns: readonly PublicPn[];
	readonly timestampedRises: readonly TimestampedFpnRise[];
}): readonly LoopFinding[];

function priceSystemBid(input: {
	readonly bid: SystemBid;
	readonly bidPrices: readonly { readonly pair: number; readonly price: GbpPerMwh; readonly volumeMwh: NonPositiveMwh }[];
	readonly acceptedOffers: readonly { readonly volumeMwh: NonNegativeMwh; readonly price: GbpPerMwh }[];
}): SystemBidCostEstimate | MissingOfferPrice;

function attributeLoopCost(input: {
	readonly finding: Extract<LoopFinding, { kind: "confirmed" }>;
	readonly bidCost: SystemBidCostEstimate;
}): LoopCostEstimate;

function replay3A(input: {
	readonly rule: Rule3A;
	readonly group: ConstraintGroupName;
	readonly marked: readonly MarkedMembership[];
	readonly bids: readonly SystemBid[];
}): Counterfactual3A;
```

`settleBidVolume` returns `ComputedBidVolume`. The fixture check compares that with `PublishedBidVolume` from BOAV for the same acceptance and period.
