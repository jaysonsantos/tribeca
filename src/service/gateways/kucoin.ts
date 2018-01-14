/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="../interfaces.ts"/>

import * as _ from "lodash";
import * as Q from "q";
import Kucoin = require('kucoin-api');
import Models = require("../../common/models");
import Utils = require("../utils");
import Interfaces = require("../interfaces");
import Config = require("../config");
import { Side } from "../../common/models";
import { setInterval } from "timers";
import NullGateway = require('./nullgw');
var uuid = require('node-uuid');

interface CancelOrder {
    orderOid: string,
    type: "BUY" | "SELL",
    symbol: string
}

interface BaseResponse {
    success: boolean,
    code: string,
    data: any,
    timestamp: number;
}

interface CreateResponse extends BaseResponse {
    msg: string
    data: ExchangeId
}

interface ExchangeId {
    orderOid: string
}

interface CreateOrderRequest {
    symbol: string
    type: "BUY" | "SELL",
    amount: number
    price: number
}

interface Balance {
    coinType: string
    balance: number
    freezeBalance: number
}

class KuCoinPriceSanitizer {
    // TODO: Use this on sendOrder, books and trades, maybe on balance too
    private mapping: {
        RPX: 10000
    }
    private useMultiplier: boolean;
    private multiplier = 1;

    constructor(pair: Models.CurrencyPair) {
        const multiplier = this.findMultiplier(pair);
        if (multiplier) {
            this.multiplier = multiplier;
            this.useMultiplier = true;
        } else {
            this.useMultiplier = false;
        }
    }

    findMultiplier = (pair: Models.CurrencyPair): number | null => {
        const mapping = this.findMapping(pair);
        if (mapping)
            return this.mapping[mapping];
        return null
    }

    findMapping = (pair: Models.CurrencyPair): string | null => {
        const mappings = [pair.base, pair.quote]
            .map(this.getIndex)
            .filter(e => e !== undefined);
        if (mappings.length > 0)
            return mappings[0];
        return null;
    }

    getIndex = (currency: Models.Currency): string | null => {
        return this.mapping[Models.fromCurrency(currency)];
    }

    fromKuCoin = (originalPrice: number): number => {
        if (!this.useMultiplier)
            return originalPrice;
        return originalPrice * this.multiplier;
    }

    toKuCoin = (multipliedPrice: number): number => {
        if (!this.useMultiplier)
            return multipliedPrice;
        return multipliedPrice / this.multiplier;
    }
}

class KuCoinSymbolProvider {
    public readonly symbol: string;

    constructor(pair: Models.CurrencyPair) {
        this.symbol = `${Models.fromCurrency(pair.base)}-${Models.fromCurrency(pair.quote)}`;
    }
}

export class KuCoinOrderGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    
    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Q.Promise<number> => { return Q(0); };

    public cancelsByClientOrderId = false;

    generateClientOrderId = (): string => {
        return uuid.v1();
    }
    private raiseTimeEvent = (o: Models.OrderStatusReport) => {
        this.OrderUpdate.trigger({
            orderId: o.orderId,
            computationalLatency: Utils.fastDiff(Utils.date(), o.time)
        })
    };

    toKucoinSide = (side: Models.Side): "BUY" | "SELL" => {
        if (side == Models.Side.Bid) {
            return "BUY";
        } else if (side == Models.Side.Ask) {
            return "SELL";
        }
        throw new Error("Unknown side");
    }

    sendOrder(order: Models.OrderStatusReport) {
        if (order.timeInForce == Models.TimeInForce.IOC)
            throw new Error("Cannot send IOCs");
        const newOrder: CreateOrderRequest = {
            amount: order.quantity,
            price: this.toKucoinSide(order.side) == "BUY" ? order.price / 1000 : order.price * 1000,
            symbol: this.symbolProvider.symbol,
            type: this.toKucoinSide(order.side)             
        };

        this.api.createOrder(newOrder).then((response: CreateResponse) => {
            if (!response.success)
                throw new Error(`Error creating order ${response}`);

            this.OrderUpdate.trigger({
                orderId: order.orderId,
                exchangeId: response.data.orderOid,
                computationalLatency: Utils.fastDiff(Utils.date(), order.time)
            });
        });
    }

    cancelOrder(cancel: Models.OrderStatusReport) {
        const payload: CancelOrder = {
            orderOid: cancel.exchangeId,
            type: this.toKucoinSide(cancel.side),
            symbol: this.symbolProvider.symbol
        };

        this.api.cancel(payload).then((response: BaseResponse) => {
            if (!response.success)
                throw new Error(`Error canceling ${response}`);

            this.OrderUpdate.trigger({
                orderId: cancel.orderId,
                computationalLatency: Utils.fastDiff(Utils.date(), cancel.time)
            });
        });
    }

    replaceOrder(replace: Models.OrderStatusReport) {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    }

    constructor(private symbolProvider: KuCoinSymbolProvider, private api: Kucoin) {
        setTimeout(() => this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected), 500);
    }
}

export class KuCoinPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    onTick = () => {
        this.updateBalance(this.pair.base);
        this.updateBalance(this.pair.quote);
    }

    updateBalance = (currency: Models.Currency) => {
        this.api.getBalance({symbol: Models.fromCurrency(currency)}).
        then((response: BaseResponse) => {
            if (!response.success) {
                throw new Error(`Error getting balance of ${Models.fromCurrency(currency)} ${response}`);
            }
            const balance: Balance = response.data;
            const position: Models.CurrencyPosition = {
                amount: balance.balance,
                heldAmount: balance.freezeBalance,
                currency: currency
            };
            
            this.PositionUpdate.trigger(position);
        });
    }

    constructor(private pair: Models.CurrencyPair, private api: Kucoin) {
        setTimeout(this.onTick, 3000);
        setInterval(this.onTick, 15000);
    }
}

export class KuCoinMarketDataGateway implements Interfaces.IMarketDataGateway {
    MarketData = new Utils.Evt<Models.Market>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();

    constructor(private _minTick: number, private symbolProvider: KuCoinSymbolProvider, private api: Kucoin) {
        setInterval(this.downloadMarketData, 5000);
        setInterval(this.downloadMarketTrades, 15000);

        setInterval(this.downloadMarketData, 2000);
        setInterval(this.downloadMarketTrades, 2000);
    }

    downloadMarketData = () => {
        this.api.getOrderBooks({
            pair: this.symbolProvider.symbol.toString()
        }).then(this.onMarketData);
        this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected);
    }

    onMarketData = (response: BaseResponse) => {
        if (!response.success)
            throw new Error(`Wrong market data returned ${response}`);
        const bids: Models.MarketSide[] = response.data.BUY.map(this.parseMarketSide);
        const asks: Models.MarketSide[] = response.data.SELL.map(this.parseMarketSide);
        this.MarketData.trigger(new Models.Market(bids, asks, new Date(response.timestamp)));
    }

    parseMarketSide = ([price, amount, volume]): Models.MarketSide => {
        return {price: price * 1000, size: amount};
    }

    downloadMarketTrades = () => {

    }
}

class KuCoinGatewayDetails implements Interfaces.IExchangeDetailsGateway {
    private baseFee = 0.1 / 100;

    public get hasSelfTradePrevention() {
        return false;
    }

    name(): string {
        return "KuCoin";
    }

    makeFee(): number {
        return this.baseFee;
    }

    takeFee(): number {
        return this.baseFee;
    }

    exchange(): Models.Exchange {
        return Models.Exchange.KuCoin;
    }

    constructor(public minTickIncrement: number) {}
}

class KuCoinGateway extends Interfaces.CombinedGateway {
    constructor(config: Config.IConfigProvider, pair: Models.CurrencyPair, api: Kucoin) {
        const minTick = 0.1;
        const symbolProvider = new KuCoinSymbolProvider(pair);
        let marketData = config.GetString("KuCoinOrderDestination") == "KuCoin" ?
            new KuCoinMarketDataGateway(minTick, symbolProvider, api) :
            new NullGateway.NullMarketDataGateway(minTick);
        super(
            marketData, 
            new KuCoinOrderGateway(symbolProvider, api), 
            new KuCoinPositionGateway(pair, api), 
            new KuCoinGatewayDetails(minTick));
    }
}

export async function createKuCoinGateway(config: Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    let api = new Kucoin(
        config.GetString("KuCoinApiKey"),
        config.GetString("KuCoinApiSecret")
    );

    if (pair.base === undefined || pair.quote === undefined)
        throw new Error(`One of the supplied token is invalid requested: ${config.GetString("TradedPair")} parsed: ${pair}`);
    return new KuCoinGateway(config, pair, api);
}