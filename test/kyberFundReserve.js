const ConversionRates = artifacts.require("./ConversionRates.sol");
const TestToken = artifacts.require("./mockContracts/TestToken.sol");
const SanityRates = artifacts.require("./SanityRates");
const MockFundWallet = artifacts.require("./mockContracts/MockFundWallet.sol");
const Reserve = artifacts.require("./KyberFundReserve");

const Helper = require("./helper.js");
const BigNumber = require('bignumber.js');

//global vars
const precisionUnits = (new BigNumber(10).pow(18));
const ethAddress = '0x00eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const precision = new BigNumber(10).pow(18);

//balances
let expectedReserveBalanceWei = 0;
let reserveTokenBalance = [];
let reserveTokenImbalance = [];

//permission groups
let admin;
let operator;
let alerter;
let network;
let withDrawAddress;

//contracts
let convRatesInst;
let reserveInst;
let sanityRate = 0;
let fundWallet;

//block data
let priceUpdateBlock;
let currentBlock;
let validRateDurationInBlocks = 10000;

//tokens data
////////////
let numTokens = 5;
let tokens = [];
let tokenAdd = [];

// imbalance data
let minimalRecordResolution = 2; //low resolution so I don't lose too much data. then easier to compare calculated imbalance values.
let maxPerBlockImbalance = 4000;
let maxTotalImbalance = maxPerBlockImbalance * 12;

//base buy and sell rates (prices)
let baseBuyRate = [];
let baseSellRate = [];

//quantity buy steps
let qtyBuyStepX = [-1400, -700, -150, 0, 150, 350, 700,  1400];
let qtyBuyStepY = [ 1000,   75,   25, 0,  0, -70, -160, -3000];

//imbalance buy steps
let imbalanceBuyStepX = [-8500, -2800, -1500, 0, 1500, 2800,  4500];
let imbalanceBuyStepY = [ 1300,   130,    43, 0,   0, -110, -1600];

//sell
//sell price will be 1 / buy (assuming no spread) so sell is actually buy price in other direction
let qtySellStepX = [-1400, -700, -150, 0, 150, 350, 700, 1400];
let qtySellStepY = [-300,   -80,  -15, 0,   0, 120, 170, 3000];

//sell imbalance step
let imbalanceSellStepX = [-8500, -2800, -1500, 0, 1500, 2800,  4500];
let imbalanceSellStepY = [-1500,  -320,   -75, 0,    0,  110,   650];


//compact data.
let sells = [];
let buys = [];
let indices = [];
let compactBuyArr = [];
let compactSellArr = [];

//remember to remove walletForToken stuffs
//check that when balances are changing that wont cause error in later tests

contract('KyberFundReserve', function(accounts) {
  it("should init globals. init ConversionRates Inst, init tokens and add to pricing inst. set basic data per token.", async function () {
        // set account addresses
        admin = accounts[0];
        operator = accounts[1];
        network = accounts[2];
        user1 = accounts[4];
        user2 = accounts[5];
        withDrawAddress = accounts[6];
        sanityRate = accounts[7];
        alerter = accounts[8];
        walletForToken = accounts[9];

        currentBlock = priceUpdateBlock = await Helper.getCurrentBlock();

//        console.log("current block: " + currentBlock);
        //init contracts
        convRatesInst = await ConversionRates.new(admin, {});

        //set pricing general parameters
        await convRatesInst.setValidRateDurationInBlocks(validRateDurationInBlocks);

        //create and add token addresses...
        for (let i = 0; i < numTokens; ++i) {
            token = await TestToken.new("test" + i, "tst" + i, 18);
            tokens[i] = token;
            tokenAdd[i] = token.address;
            await convRatesInst.addToken(token.address);
            await convRatesInst.setTokenControlInfo(token.address, minimalRecordResolution, maxPerBlockImbalance, maxTotalImbalance);
            await convRatesInst.enableTokenTrade(token.address);
        }

        assert.equal(tokens.length, numTokens, "bad number tokens");

        let result = await convRatesInst.addOperator(operator);
        await convRatesInst.addAlerter(alerter);
    });

    it("should set base prices + compact data price factor + step function. for all tokens.", async function () {
       //buy is ether to token rate. sale is token to ether rate. so sell == 1 / buy. assuming we have no spread.
       let tokensPerEther;
       let ethersPerToken;

       for (i = 0; i < numTokens; ++i) {
           tokensPerEther = (new BigNumber(precisionUnits.mul((i + 1) * 3)).floor());
           ethersPerToken = (new BigNumber(precisionUnits.div((i + 1) * 3)).floor());
           baseBuyRate.push(tokensPerEther.valueOf());
           baseSellRate.push(ethersPerToken.valueOf());
       }
       assert.equal(baseBuyRate.length, tokens.length);
       assert.equal(baseSellRate.length, tokens.length);

       buys.length = sells.length = indices.length = 0;

       await convRatesInst.setBaseRate(tokenAdd, baseBuyRate, baseSellRate, buys, sells, currentBlock, indices, {from: operator});

       //set compact data
       compactBuyArr = [0, 12, -5, 0, 0, 06, 07, 08, 09, 10, 11, 12, 13, 14];
       let compactBuyHex = Helper.bytesToHex(compactBuyArr);
       buys.push(compactBuyHex);

       compactSellArr = [0, -50, 95, 0, 0, 26, 27, 28, 29, 30, 31, 32, 33, 34];
       let compactSellHex = Helper.bytesToHex(compactSellArr);
       sells.push(compactSellHex);

       indices[0] = 0;

       assert.equal(indices.length, sells.length, "bad sells array size");
       assert.equal(indices.length, buys.length, "bad buys array size");

       await convRatesInst.setCompactData(buys, sells, currentBlock, indices, {from: operator});

       //all start with same step functions.
       for (let i = 0; i < numTokens; ++i) {
           await convRatesInst.setQtyStepFunction(tokenAdd[i], qtyBuyStepX, qtyBuyStepY, qtySellStepX, qtySellStepY, {from:operator});
           await convRatesInst.setImbalanceStepFunction(tokenAdd[i], imbalanceBuyStepX, imbalanceBuyStepY, imbalanceSellStepX, imbalanceSellStepY, {from:operator});
       }
   });

   //it shoudl init reserve and mockfundwallet here, send token/ether balance here instead

   it("should init reserve and fundWallet and send tokens/ether to fundWallet", async function () {
        reserveInst = await Reserve.new(network, convRatesInst.address, admin);
        await reserveInst.setContracts(network, convRatesInst.address, 0);

        await reserveInst.addOperator(operator);
        await reserveInst.addAlerter(alerter);
        await convRatesInst.setReserveAddress(reserveInst.address);
        for (let i = 0; i < numTokens; ++i) {
            await reserveInst.approveWithdrawAddress(tokenAdd[i],accounts[0],true);
        }

        //set fund wallet here
        fundWalletInst = await MockFundWallet.new(reserveInst.address, 60, 60, 60, 60);

        //note may not have enough ether/tokens for the 2 rounds of testing
        //send tokens and ethers
        //set reserve balance. 10000 wei ether + per token 1000 wei ether value according to base price.
        let fundWalletEtherInit = 5000 * 2;
        await Helper.sendEtherWithPromise(accounts[9], fundWalletInst.address, fundWalletEtherInit);

        let balance = await Helper.getBalancePromise(fundWalletInst.address);
        expectedFundWalletBalanceWei = balance.valueOf();

        assert.equal(balance.valueOf(), fundWalletEtherInit, "wrong ether balance");

        //transfer tokens to reserve. each token same wei balance
        for (let i = 0; i < numTokens; ++i) {
            token = tokens[i];
            let amount = (new BigNumber(fundWalletEtherInit)).mul(baseBuyRate[i]).div(precisionUnits);
            await token.transfer(fundWalletInst.address, amount.valueOf());
            let balance = await token.balanceOf(fundWalletInst.address);
            assert.equal(amount.valueOf(), balance.valueOf());
            reserveTokenBalance.push(amount);
            reserveTokenImbalance.push(new BigNumber(0));
        }
    });

    //should test reverted scenario for set contracts call
    it("should test reverted scenario for set contracts call.", async function () {
        //legal call
        await reserveInst.setContracts(network, convRatesInst.address, 0, {from:admin});

        try {
            await reserveInst.setContracts(0, convRatesInst.address, 0, {from:admin});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        try {
            await reserveInst.setContracts(network, 0, 0, {from:admin});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }
    });

    //test reverted scenario for set fund wallet call
    it("should test reverted scenario for set fundWallet call.", async function () {
        //legal call
        await reserveInst.setFundWallet(fundWalletInst.address, {from:admin});

        try {
            await reserveInst.setFundWallet(0, {from:admin});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }
    });

    //adminP tests jump to time in first unit test (getConversion Rates, withdraw, trade(try buy and sell) should all fail or return 0)
    it("should return 0 conversion rates for ether and token in adminP.", async function() {
      //jump forward time maybe?
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;
      let amountTwei = 25 * 1;

      let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //check correct rate calculated
      assert.equal(buyRate.valueOf(), 0, "unexpected rate.");
      //check correct rate calculated
      assert.equal(sellRate.valueOf(), 0, "unexpected rate.");

    });

    it("should fail withdraw for both ether and token.", async function(){
      let tokenInd = 1;
      let amount = 10;
      let token = tokens[tokenInd];

      // first token
      await reserveInst.approveWithdrawAddress(tokenAdd[tokenInd], withDrawAddress, true);
      await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});

      //ether
      await reserveInst.approveWithdrawAddress(ethAddress, withDrawAddress, true);
      await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});

      //try withdraw token - expect fail
      try {
          await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

      //try withdraw ether - expect fail
      try {
          await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    it("should fail buy in adminP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;

      let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);

      //try tade should fail
      try {
          await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from:network, value:amountWei});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    it("should fail sell in adminP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountTwei = 25 * 1;

      //so here transfer tokens to network and approve allowance from network to reserve.
      await token.transfer(network, amountTwei);

      //get sell rate
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //pre trade step, approve allowance from user to network.
      await token.approve(reserveInst.address, amountTwei, {from: network});

      //try tade should fail
      try {
          await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, true, {from:network});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }
    });

    //raiseP tests jump to time in first unit test(getBalance, getConversion Rates, withdraw, trade should all fail or return 0)
    it("should return 0 conversion rates for ether and token in adminP.", async function() {
      //jump forward time!!
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;
      let amountTwei = 25 * 1;

      await Helper.advanceTimeAndBlock(3600);

      let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //check correct rate calculated
      assert.equal(buyRate.valueOf(), 0, "unexpected rate.");
      //check correct rate calculated
      assert.equal(sellRate.valueOf(), 0, "unexpected rate.");

    });

    it("should fail withdraw for both ether and token.", async function(){
      let tokenInd = 1;
      let amount = 10;
      let token = tokens[tokenInd];

      // first token
      await reserveInst.approveWithdrawAddress(tokenAdd[tokenInd], withDrawAddress, true);
      await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});

      //ether
      await reserveInst.approveWithdrawAddress(ethAddress, withDrawAddress, true);
      await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});

      //try withdraw token - expect fail
      try {
          await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

      //try withdraw ether - expect fail
      try {
          await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    it("should fail buy in adminP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;

      let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);

      //try tade should fail
      try {
          await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from:network, value:amountWei});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    it("should fail sell in adminP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountTwei = 25 * 1;

      //so here transfer tokens to network and approve allowance from network to reserve.
      await token.transfer(network, amountTwei);

      //get sell rate
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //pre trade step, approve allowance from user to network.
      await token.approve(reserveInst.address, amountTwei, {from: network});

      //try tade should fail
      try {
          await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, true, {from:network});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }
    });

    //opperateP jump to time tests in first unit test
    //small buys -- success
    it("should perform small buy (no steps) and check: balances changed, rate is expected rate.", async function () {
      //jump forward time!!
       let tokenInd = 3;
       let token = tokens[tokenInd]; //choose some token
       let amountWei = 2 * 1;

       await Helper.advanceTimeAndBlock(3600);

       //verify base rate
       let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);
       let expectedRate = (new BigNumber(baseBuyRate[tokenInd]));
       let destQty = (new BigNumber(amountWei).mul(baseBuyRate[tokenInd])).div(precisionUnits);
       let extraBps = getExtraBpsForBuyQuantity(destQty);
       expectedRate = addBps(expectedRate, extraBps);

       //check correct rate calculated
       assert.equal(buyRate.valueOf(), expectedRate.valueOf(), "unexpected rate.");

       //perform trade
       await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from:network, value:amountWei});

       //check higher ether balance on fundWallet
       expectedReserveBalanceWei = (expectedReserveBalanceWei * 1) + amountWei;
       expectedReserveBalanceWei -= expectedReserveBalanceWei % 1;
       let balance = await reserveInst.getBalance(ethAddress);
       assert.equal(balance.valueOf(), expectedReserveBalanceWei, "bad reserve balance wei")

       //check token balances
       //check token balance on user1
       let tokenTweiBalance = await token.balanceOf(user1);
       let expectedTweiAmount = expectedRate.mul(amountWei).div(precisionUnits);
       assert.equal(tokenTweiBalance.valueOf(), expectedTweiAmount.valueOf(), "bad token balance");

       //check lower token balance on fundWallet
       reserveTokenBalance[tokenInd] -= expectedTweiAmount;
       reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].add(expectedTweiAmount); //imbalance represents how many missing tokens
       let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
       assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");
   });
    //stepped buy
    it("should perform a few buys with steps and check: correct balances change, rate is expected rate.", async function () {
        let tokenInd = 2;
        let token = tokens[tokenInd]; //choose some token
        let amountWei;
        let totalWei = 0;
        let totalExpectedTwei = 0;

        for (let i = 0; i > 19; i++) {
            amountWei = (7 * i) + 11 * 1;
            let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);

            //verify price/rate against set price
            let expectedRate = (new BigNumber(baseBuyRate[tokenInd]));
            //first calculate number of destination tokens according to basic rate
//            console.log("expected1" + expectedRate)
            let destQty = (new BigNumber(amountWei).mul(expectedRate)).div(precisionUnits);
            let extraBps = getExtraBpsForBuyQuantity(destQty);
            expectedRate = addBps(expectedRate, extraBps);
//            console.log("expected2" + expectedRate)
            extraBps = getExtraBpsForImbalanceBuyQuantity(reserveTokenImbalance[tokenInd].valueOf());
            expectedRate = addBps(expectedRate, extraBps);
//console.log("expected3" + expectedRate)

            //function calculateRateAmount(isBuy, tokenInd, srcQty, maxDestAmount)
//            let expected = calculateRateAmount(true, tokenInd, amountWei)
//            console.log("expected from function" + expected);
            assert.equal(buyRate.valueOf(), expectedRate.valueOf(), "unexpected rate. loop: " + i);

            let expectedTweiAmount = expectedRate.mul(amountWei).div(precisionUnits);
            totalExpectedTwei += (1 * expectedTweiAmount);
            reserveTokenBalance[tokenInd].sub(expectedTweiAmount);

            await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from : network, value:amountWei});
            totalWei += (1 * amountWei);
        };

        //check higher ether balance on fundWallet
        expectedReserveBalanceWei = (expectedReserveBalanceWei * 1) + totalWei;
        expectedReserveBalanceWei -= expectedReserveBalanceWei % 1;
        let balance = await reserveInst.getBalance(ethAddress);
        assert.equal(balance.valueOf(), expectedReserveBalanceWei, "bad reserve balance");

        //check lower token balance in fundWallet
        let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
        assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");

        //check token balance on user1
        let tokenTweiBalance = await token.balanceOf(user1);
        assert.equal(tokenTweiBalance.valueOf(), totalExpectedTwei.valueOf(), "bad token balance");
    });
    //small sell
    it("should perform small sell and check: balances changed, rate is expected rate.", async function () {
        let tokenInd = 3;
        let token = tokens[tokenInd]; //choose some token
        let amountTwei = 25 * 1;

        //no need to transfer initial balance to user
        //in the full scenario. user approves network which collects the tokens and approves reserve
        //which collects tokens from network.
        //so here transfer tokens to network and approve allowance from network to reserve.
        await token.transfer(network, amountTwei);

        //verify sell rate
        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

        let expectedRate = (new BigNumber(baseSellRate[tokenInd]));
        let extraBps = getExtraBpsForSellQuantity(amountTwei);
        expectedRate = addBps(expectedRate, extraBps);
        expectedRate.floor();

        //check correct rate calculated
        assert.equal(sellRate.valueOf(), expectedRate.valueOf(), "unexpected rate.");

        //pre trade step, approve allowance from user to network.
        await token.approve(reserveInst.address, amountTwei, {from: network});

        //perform trade
        await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, true, {from:network});

        //check lower ether balance on fundWallet
        let amountWei = (new BigNumber(amountTwei).mul(expectedRate)).div(precisionUnits).floor();
        expectedReserveBalanceWei = (new BigNumber(expectedReserveBalanceWei)).sub(amountWei).floor();
        let balance = await reserveInst.getBalance(ethAddress);
        assert.equal(balance.valueOf(), expectedReserveBalanceWei.valueOf(), "bad reserve balance wei");

        //check token balances
        ///////////////////////

        //check token balance on network zeroed
        let tokenTweiBalance = await token.balanceOf(network);

        assert.equal(tokenTweiBalance.valueOf(), 0, "bad token balance");

        //check token balance on fundWallet was updated (higher)
        reserveTokenBalance[tokenInd] += (amountTwei * 1);
        reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].sub(amountTwei); //imbalance represents how many missing tokens
        let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
        assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");
    });

    //stepped sells
    it("should perform a few sells with steps. check: balances changed, rate is expected rate.", async function () {
        let tokenInd = 3;
        let token = tokens[tokenInd]; //choose some token

        //no need to transfer initial balance to user
        //in the full scenario. user approves network which collects the tokens and approves reserve
        //which collects tokens from network.
        //so here transfer tokens to network and approve allowance from network to reserve.
        for (let i = 0; i < 17; ++i)
        {
            let amountTwei = (i + 1) * 31;

            await token.transfer(network, amountTwei);

            //verify sell rate
            let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

            let expectedRate = (new BigNumber(baseSellRate[tokenInd])).floor();
            let extraBps = getExtraBpsForSellQuantity(amountTwei);
            expectedRate = addBps(expectedRate, extraBps);
            extraBps = getExtraBpsForImbalanceSellQuantity((reserveTokenImbalance[tokenInd].sub(amountTwei)));
            expectedRate = addBps(expectedRate, extraBps);
            expectedRate = expectedRate.floor();

            //check correct rate calculated
            assert.equal(sellRate.valueOf(), expectedRate.valueOf(), "unexpected rate.");

            //pre trade step, approve allowance from network to reserve (on reserve test we skip step where user sends to netwok)
            await token.approve(reserveInst.address, amountTwei, {from: network});

            //perform trade
            await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, true, {from:network});

            //check lower ether balance on fundWallet
            let amountWei = (new BigNumber(amountTwei).mul(expectedRate)).div(precisionUnits).floor();
            expectedReserveBalanceWei = (new BigNumber(expectedReserveBalanceWei)).sub(amountWei).floor();
            let balance = await reserveInst.getBalance(ethAddress);
            assert.equal(balance.valueOf(), expectedReserveBalanceWei.valueOf(), "bad reserve balance wei");

            //check token balances
            ///////////////////////

            //check token balance on network zeroed
            let tokenTweiBalance = await token.balanceOf(network);

            assert.equal(tokenTweiBalance.valueOf(), 0, "bad token balance network");

            //check token balance on fundWallet was updated (higher)reserveTokenBalance[tokenInd] += (amountTwei * 1);
            reserveTokenBalance[tokenInd] += (amountTwei * 1);
            reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].sub(amountTwei); //imbalance represents how many missing tokens
            let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
            assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");
        }
    });

    //should verify trade success when validation disabled
    it("should verify trade success when validation disabled.", async function () {
        let tokenInd = 3;
        let token = tokens[tokenInd]; //choose some token
        let amountTwei = 25 * 1;


        //no need to transfer initial balance to user
        //in the full scenario. user approves network which collects the tokens and approves reserve
        //which collects tokens from network.
        //so here transfer tokens to network and approve allowance from network to reserve.
        await token.transfer(network, amountTwei);

        //pre trade step, approve allowance from user to network.
        await token.approve(reserveInst.address, amountTwei, {from: network});

        //sell rate
        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

        //perform trade
        await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, false, {from:network});

        //check lower ether balance on fundWallet
        let amountWei = (new BigNumber(amountTwei).mul(sellRate)).div(precisionUnits).floor();
        expectedReserveBalanceWei = (new BigNumber(expectedReserveBalanceWei)).sub(amountWei).floor();
        let balance = await reserveInst.getBalance(ethAddress);
        assert.equal(balance.valueOf(), expectedReserveBalanceWei.valueOf(), "bad reserve balance wei");

        //check token balances
        ///////////////////////

        //check token balance on network zeroed
        let tokenTweiBalance = await token.balanceOf(network);

        assert.equal(tokenTweiBalance.valueOf(), 0, "bad token balance");

        //check token balance on fundWallet was updated (higher)
        reserveTokenBalance[tokenInd] += (amountTwei * 1);
        reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].sub(amountTwei); //imbalance represents how many missing tokens
        let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
        assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");
    });

    //should test sell trade reverted without token approved. -- maybe don't repeat
    it("should test sell trade reverted without token approved.", async function () {
        let tokenInd = 2;
        let token = tokens[tokenInd]; //choose some token
        let amount = 300 * 1;

        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);

        await token.transfer(network, amount);

        //
        try {
            await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        //now see success with approve
        await token.approve(reserveInst.address, amount, {from: network});
        await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network});
    });

    //should test trade reverted when trade disabled -- maybe don't repeat
    it("should test trade reverted when trade disabled .", async function () {
        let tokenInd = 2;
        let token = tokens[tokenInd]; //choose some token
        let amount = 300 * 1;

        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);

        await token.transfer(network, amount);
        await token.approve(reserveInst.address, amount, {from: network});

        await reserveInst.disableTrade({from:alerter});
        //
        try {
            await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        await reserveInst.enableTrade({from:admin});
        //now see success on same trade when enabled
        await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network});
    });

    //should test trade reverted when conversion rate 0
    it("should test trade reverted when conversion rate 0.", async function () {
        let tokenInd = 2;
        let token = tokens[tokenInd]; //choose some token
        let amount = 300 * 1;

        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);

        await token.transfer(network, amount);
        await token.approve(reserveInst.address, amount, {from: network});

        //
        try {
            await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, 0, true, {from:network});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network});
    });

    //should test trade reverted when dest amount is 0
    it("should test trade reverted when dest amount is 0.", async function () {
        let tokenInd = 1;
        let token = tokens[tokenInd]; //choose some token
        let amountLow = 1 * 1;
        let amountHigh = 300 * 1;

        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountLow, currentBlock);

        await token.transfer(network, (amountLow*1 + amountHigh*1));
        await token.approve(reserveInst.address, (amountLow*1 + amountHigh*1), {from: network});

        //
        try {
            await reserveInst.trade(tokenAdd[tokenInd], amountLow, ethAddress, user2, sellRate, true, {from:network});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        await reserveInst.trade(tokenAdd[tokenInd], amountHigh, ethAddress, user2, sellRate, true, {from:network});
        reserveTokenBalance[tokenInd] = reserveTokenBalance[tokenInd]*1 + amountHigh*1;
        reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].sub(amountHigh);
    });

    //should test buy trade reverted when not sending correct ether value
    it("should test buy trade reverted when not sending correct ether value.", async function () {
        let tokenInd = 4;
        let token = tokens[tokenInd]; //choose some token
        let amount = 3;

        let rate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amount, currentBlock);

       //test trade reverted when sending wrong ether value
        try {
            await reserveInst.trade(ethAddress, amount, tokenAdd[tokenInd], user2, rate, true, {from:network, value:1});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        //see it works when sending correct value
        await reserveInst.trade(ethAddress, amount, tokenAdd[tokenInd], user2, rate, true, {from:network, value:amount});
    });

    //should test trade reverted when not sent from network
    it("should test trade reverted when not sent from network.", async function () {
        let tokenInd = 4;
        let token = tokens[tokenInd]; //choose some token
        let amount = 3;
        let rate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amount, currentBlock);

       //test trade reverted when sending wrong ether value
        try {
            await reserveInst.trade(ethAddress, amount, tokenAdd[tokenInd], user2, rate, true, {from:operator, value:amount});
            assert(false, "throw was expected in line above.")
        } catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        //see same trade works when sending correct value
        await reserveInst.trade(ethAddress, amount, tokenAdd[tokenInd], user2, rate, true, {from:network, value:amount});
    });

    //should test trade reverted when sending ether value with sell trade
    it("should test trade reverted when sending ether value with sell trade.", async function () {
       let tokenInd = 1;
       let token = tokens[tokenInd]; //choose some token
       let amount = 300 * 1;

       let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);

       await token.transfer(network, amount);
       await token.approve(reserveInst.address, amount, {from: network});

       //
       try {
           await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network, value:3});
           assert(false, "throw was expected in line above.")
       } catch(e){
           assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
       }

       await reserveInst.trade(tokenAdd[tokenInd], amount, ethAddress, user2, sellRate, true, {from:network, value: 0});
       reserveTokenBalance[tokenInd] = reserveTokenBalance[tokenInd]*1 + amount*1;
       reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].sub(amount);
    });

    //should approve withdraw address and withdraw. token and ether.
    it("should approve withdraw address and withdraw. token and ether", async function () {
        let tokenInd = 1;
        let amount = 10;
        let token = tokens[tokenInd];

        // first token
        await reserveInst.approveWithdrawAddress(tokenAdd[tokenInd], withDrawAddress, true);
        await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});

        reserveTokenBalance[tokenInd] -= amount;
        let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
        assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");

        reportedBalance = await token.balanceOf(withDrawAddress);
        assert.equal(reportedBalance.valueOf(), amount, "bad token balance on withdraw address");

        //ether
        expectedReserveBalanceWei = await reserveInst.getBalance(ethAddress);

        await reserveInst.approveWithdrawAddress(ethAddress, withDrawAddress, true);
        await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});

        expectedReserveBalanceWei -= amount;
        reportedBalance = await reserveInst.getBalance(ethAddress);
        assert.equal(reportedBalance.valueOf(), expectedReserveBalanceWei, "bad eth balance on reserve");
    });

    //should test reverted scenarios for withdraw -- maybe don't repeat
    it ("should test reverted scenarios for withdraw", async function() {
        let tokenInd = 1;
        let amount = 10;

        //make sure withdraw reverted from non operator
        try {
            await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress);
            assert(false, "throw was expected in line above.")
        }
        catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        //make sure withdraw reverted to non approved token
        try {
            await reserveInst.withdraw(tokenAdd[tokenInd - 1], amount, withDrawAddress, {from: operator});
            assert(false, "throw was expected in line above.")
        }
        catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        //make sure withdraw reverted to non approved address
        try {
            await reserveInst.withdraw(tokenAdd[tokenInd], amount, accounts[9], {from: operator});
            assert(false, "throw was expected in line above.")
        }
        catch(e){
            assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }
    });

    //should test get dest qty
    it ("should test get dest qty", async function() {
        let srcQty = 100;
        let rate = precision.div(2); //1 to 2. in precision units

        let srcDecimal = 10;
        let dstDecimal = 13;

        let tokenA = await TestToken.new("source", "src", srcDecimal);
        let tokenB = await TestToken.new("dest", "dst", dstDecimal);

        //get dest QTY
        let expectedDestQty = (srcQty * rate / precision) * (10 ** (dstDecimal - srcDecimal));

        let reportedDstQty = await reserveInst.getDestQty(tokenA.address, tokenB.address, srcQty, rate);

        assert.equal(expectedDestQty.valueOf(), reportedDstQty.valueOf(), "unexpected dst qty");
    });

    //should test get src qty
    it ("should test get src qty", async function() {
        let rate = precision.div(2); //1 to 2. in precision units

        let srcDecimal = 10;
        let dstDecimal = 13;

        let tokenA = await TestToken.new("source", "src", srcDecimal);
        let tokenB = await TestToken.new("dest", "dst", dstDecimal);

        //get src qty
        let dstQty = 100000;
        let expectedSrcQty = (((precision / rate)* dstQty * (10**(srcDecimal - dstDecimal))));

        let reportedSrcQty = await reserveInst.getSrcQty(tokenA.address, tokenB.address, dstQty, rate);

        assert.equal(expectedSrcQty.valueOf(), reportedSrcQty.valueOf(), "unexpected src qty");
    });

    //should test get conversion rate options
    it ("should test get conversion rate options", async function() {
        let tokenInd = 3;
        let amountTwei = 3;

        //test normal case.
        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

        let expectedRate = (new BigNumber(baseSellRate[tokenInd])).floor();
        let extraBps = getExtraBpsForSellQuantity(amountTwei);
        expectedRate = addBps(expectedRate, extraBps);
        extraBps = getExtraBpsForImbalanceSellQuantity((reserveTokenImbalance[tokenInd].sub(amountTwei)));
        expectedRate = addBps(expectedRate, extraBps);
        expectedRate = expectedRate.floor();

        //check correct rate calculated
        assert.equal(sellRate.valueOf(), expectedRate.valueOf(), "unexpected rate.");

        //disable trade and test
        await reserveInst.disableTrade({from: alerter})
        sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);
        assert.equal(0, sellRate.valueOf(), "rate not 0");
        await reserveInst.enableTrade({from:admin});

        //try token to token
        sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], tokenAdd[2], amountTwei, currentBlock);
        assert.equal(0, sellRate.valueOf(), "rate not 0");

        //test normal case.
        sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

        //check correct rate calculated
        assert.equal(sellRate.valueOf(), expectedRate.valueOf(), "unexpected rate.");
    });

    //should test get conversion rate return 0 when sanity rate is lower the calculated rate
    it ("should test get conversion rate return 0 when sanity rate is lower the calculated rate", async function() {
        let tokenInd = 1;
        let token = tokens[tokenInd]; //choose some token
        let amount = 30 * 1;

        let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);

        await token.transfer(network, amount);
        await token.approve(reserveInst.address, amount, {from: network});

        //set sanity rate data...
        sanityRate = await SanityRates.new(admin);
        await sanityRate.addOperator(operator);
        let tokens2 = [tokenAdd[tokenInd]];

        //set low rate - that will be smaller then calculated and cause return value 0
        let rates2 = [new BigNumber(sellRate).div(2).floor()];

        await sanityRate.setSanityRates(tokens2, rates2, {from: operator});
        let diffs = [1000];
        await sanityRate.setReasonableDiff(tokens2, diffs, {from: admin});

        await reserveInst.setContracts(network, convRatesInst.address, sanityRate.address, {from:admin});

        let nowRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);

        assert.equal(nowRate.valueOf(), 0, "expected zero rate.");

        //set high sanity rate. that will not fail the calculated rate.
        rates2 = [new BigNumber(sellRate).mul(2).floor()];
        await sanityRate.setSanityRates(tokens2, rates2, {from: operator});
        nowRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amount, currentBlock);
        assert(nowRate.valueOf() > 0, "expected valid rate.");
        await reserveInst.setContracts(network, convRatesInst.address, 0, {from:admin});
    });

    //should zero reserve balance and see that get rate returns zero when not enough dest balance eth/token
    it("should zero reserve balance and see that get rate returns zero when not enough dest balance", async function() {
        let tokenInd = 1;
        let amountTwei = maxPerBlockImbalance - 1;
        let token = tokens[tokenInd];
        let srcQty = 50; //some high number of figure out ~rate

        //set to reserve
        let balance = await reserveInst.getBalance(tokenAdd[tokenInd]);
        await reserveInst.approveWithdrawAddress(tokenAdd[tokenInd], withDrawAddress, true);
        await reserveInst.withdraw(tokenAdd[tokenInd], balance, withDrawAddress, {from: operator});

        let balance1 = await reserveInst.getBalance(tokenAdd[tokenInd]);

        assert.equal(balance1.valueOf(0), 0, "expected balance 0");

        rate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], srcQty, currentBlock);
        assert.equal(rate.valueOf(), 0, "expected rate 0");

        //send funds back and then check again for non zero
        //send balance back
        await token.transfer(fundWalletInst.address, balance);
    });

    //liquidP tests include withdraw-- can withdraw token
    //small buys -- success
    it("should perform small buy (no steps) and check: balances changed, rate is expected rate.", async function () {
      //jump forward time!!
       let tokenInd = 3;
       let token = tokens[tokenInd]; //choose some token
       let amountWei = 2 * 1;

       await Helper.advanceTimeAndBlock(3600);

       //verify base rate
       let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);
       let expectedRate = (new BigNumber(baseBuyRate[tokenInd]));
       let destQty = (new BigNumber(amountWei).mul(baseBuyRate[tokenInd])).div(precisionUnits);
       let extraBps = getExtraBpsForBuyQuantity(destQty);
       expectedRate = addBps(expectedRate, extraBps);

       //check correct rate calculated
       assert.equal(buyRate.valueOf(), expectedRate.valueOf(), "unexpected rate.");

       //perform trade
       await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from:network, value:amountWei});

       //check higher ether balance on fundWallet
       expectedReserveBalanceWei = (expectedReserveBalanceWei * 1) + amountWei;
       expectedReserveBalanceWei -= expectedReserveBalanceWei % 1;
       let balance = await reserveInst.getBalance(ethAddress);
       assert.equal(balance.valueOf(), expectedReserveBalanceWei, "bad reserve balance wei")

       //check token balances
       //check token balance on user1
       let tokenTweiBalance = await token.balanceOf(user1);
       let expectedTweiAmount = expectedRate.mul(amountWei).div(precisionUnits);
       assert.equal(tokenTweiBalance.valueOf(), expectedTweiAmount.valueOf(), "bad token balance");

       //check lower token balance on fundWallet
       reserveTokenBalance[tokenInd] -= expectedTweiAmount;
       reserveTokenImbalance[tokenInd] = reserveTokenImbalance[tokenInd].add(expectedTweiAmount); //imbalance represents how many missing tokens
       let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
       assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");
   });

    //stepped buy -- success
    it("should perform a few buys with steps and check: correct balances change, rate is expected rate.", async function () {
      let tokenInd = 2;
      let token = tokens[tokenInd]; //choose some token
      let amountWei;
      let totalWei = 0;
      let totalExpectedTwei = 0;

      for (let i = 0; i > 19; i++) {
          amountWei = (7 * i) + 11 * 1;
          let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);

          //verify price/rate against set price
          let expectedRate = (new BigNumber(baseBuyRate[tokenInd]));
          //first calculate number of destination tokens according to basic rate
//            console.log("expected1" + expectedRate)
          let destQty = (new BigNumber(amountWei).mul(expectedRate)).div(precisionUnits);
          let extraBps = getExtraBpsForBuyQuantity(destQty);
          expectedRate = addBps(expectedRate, extraBps);
//            console.log("expected2" + expectedRate)
          extraBps = getExtraBpsForImbalanceBuyQuantity(reserveTokenImbalance[tokenInd].valueOf());
          expectedRate = addBps(expectedRate, extraBps);
//console.log("expected3" + expectedRate)

          //function calculateRateAmount(isBuy, tokenInd, srcQty, maxDestAmount)
//            let expected = calculateRateAmount(true, tokenInd, amountWei)
//            console.log("expected from function" + expected);
          assert.equal(buyRate.valueOf(), expectedRate.valueOf(), "unexpected rate. loop: " + i);

          let expectedTweiAmount = expectedRate.mul(amountWei).div(precisionUnits);
          totalExpectedTwei += (1 * expectedTweiAmount);
          reserveTokenBalance[tokenInd].sub(expectedTweiAmount);

          await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from : network, value:amountWei});
          totalWei += (1 * amountWei);
      };

      //check higher ether balance on fundWallet
      expectedReserveBalanceWei = (expectedReserveBalanceWei * 1) + totalWei;
      expectedReserveBalanceWei -= expectedReserveBalanceWei % 1;
      let balance = await reserveInst.getBalance(ethAddress);
      assert.equal(balance.valueOf(), expectedReserveBalanceWei, "bad reserve balance");

      //check lower token balance in fundWallet
      let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
      assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");

      //check token balance on user1
      let tokenTweiBalance = await token.balanceOf(user1);
      assert.equal(tokenTweiBalance.valueOf(), totalExpectedTwei.valueOf(), "bad token balance");
    });

    //small sell -- should fail need to edit expected behaviour to this
    it("should fail sell in liquidP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountTwei = 25 * 1;

      //so here transfer tokens to network and approve allowance from network to reserve.
      await token.transfer(network, amountTwei);

      //get sell rate
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //pre trade step, approve allowance from user to network.
      await token.approve(reserveInst.address, amountTwei, {from: network});

      //try tade should fail
      try {
          await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, true, {from:network});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }
    });

    it("should return 0 conversion rates for ether in liquidP.", async function() {
      //jump forward time!!
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;
      let amountTwei = 25 * 1;

      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //check correct rate calculated
      assert.equal(sellRate.valueOf(), 0, "unexpected rate.");

    });


    //should approve withdraw address and withdraw. token.
    it("should approve withdraw address and withdraw token", async function () {
        let tokenInd = 1;
        let amount = 10;
        let token = tokens[tokenInd];

        // first token
        await reserveInst.approveWithdrawAddress(tokenAdd[tokenInd], withDrawAddress, true);
        await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});

        reserveTokenBalance[tokenInd] -= amount;
        let reportedBalance = await reserveInst.getBalance(tokenAdd[tokenInd]);
        assert.equal(reportedBalance.valueOf(), reserveTokenBalance[tokenInd].valueOf(), "bad token balance on reserve");

        reportedBalance = await token.balanceOf(withDrawAddress);
        assert.equal(reportedBalance.valueOf(), amount, "bad token balance on withdraw address");
    });

    //withdraw ether should fail
    it("should fail withdraw for ether.", async function(){
      let tokenInd = 1;
      let amount = 10;
      let token = tokens[tokenInd];

      //ether
      await reserveInst.approveWithdrawAddress(ethAddress, withDrawAddress, true);
      await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});

      //try withdraw ether - expect fail
      try {
          await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    //claimP tests jump to time(getBalance, getConversion Rates, withdraw, trade should all fail or return 0)
    it("should return 0 conversion rates for ether and token in adminP.", async function() {
      //jump forward time!!
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;
      let amountTwei = 25 * 1;

      await Helper.advanceTimeAndBlock(3600);

      let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //check correct rate calculated
      assert.equal(buyRate.valueOf(), 0, "unexpected rate.");
      //check correct rate calculated
      assert.equal(sellRate.valueOf(), 0, "unexpected rate.");

    });

    it("should fail withdraw for both ether and token.", async function(){
      let tokenInd = 1;
      let amount = 10;
      let token = tokens[tokenInd];

      // first token
      await reserveInst.approveWithdrawAddress(tokenAdd[tokenInd], withDrawAddress, true);
      await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});

      //ether
      await reserveInst.approveWithdrawAddress(ethAddress, withDrawAddress, true);
      await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});

      //try withdraw token - expect fail
      try {
          await reserveInst.withdraw(tokenAdd[tokenInd], amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

      //try withdraw ether - expect fail
      try {
          await reserveInst.withdraw(ethAddress, amount, withDrawAddress, {from: operator});
          assert(false, "throw was expected in line above.")
      }
      catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    it("should fail buy in adminP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountWei = 2 * 1;

      let buyRate = await reserveInst.getConversionRate(ethAddress, tokenAdd[tokenInd], amountWei, currentBlock);

      //try tade should fail
      try {
          await reserveInst.trade(ethAddress, amountWei, tokenAdd[tokenInd], user1, buyRate, true, {from:network, value:amountWei});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }

    });

    it("should fail sell in adminP.", async function () {
      let tokenInd = 3;
      let token = tokens[tokenInd]; //choose some token
      let amountTwei = 25 * 1;

      //so here transfer tokens to network and approve allowance from network to reserve.
      await token.transfer(network, amountTwei);

      //get sell rate
      let sellRate = await reserveInst.getConversionRate(tokenAdd[tokenInd], ethAddress, amountTwei, currentBlock);

      //pre trade step, approve allowance from user to network.
      await token.approve(reserveInst.address, amountTwei, {from: network});

      //try tade should fail
      try {
          await reserveInst.trade(tokenAdd[tokenInd], amountTwei, ethAddress, user2, sellRate, true, {from:network});
          assert(false, "throw was expected in line above.")
      } catch(e){
          assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
      }
    });

    //should test can't init this contract with empty contracts (address 0)
    it("should test can't init this contract with empty contracts (address 0).", async function () {
      //jump forward time!!
        let reserve;

        try {
           reserve = await Reserve.new(network, convRatesInst.address, 0);
           assert(false, "throw was expected in line above.")
        } catch(e){
           assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        try {
           reserve =  await Reserve.new(network, 0, admin);
           assert(false, "throw was expected in line above.")
        } catch(e){
           assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        try {
           reserve =  await Reserve.new(0, convRatesInst.address, admin);
           assert(false, "throw was expected in line above.")
        } catch(e){
           assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        reserve = await Reserve.new(network, convRatesInst.address, admin);

        try {
           await reserve.setContracts(0, convRatesInst.address, 0);
           assert(false, "throw was expected in line above.")
        } catch(e){
           assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        try {
           await reserve.setContracts(network, 0, 0);
           assert(false, "throw was expected in line above.")
        } catch(e){
           assert(Helper.isRevertErrorMessage(e), "expected throw but got: " + e);
        }

        //sanity rates can currently be empty
        await reserve.setContracts(network, convRatesInst.address, 0);
    });
});

function convertRateToPricingRate (baseRate) {
// conversion rate in pricing is in precision units (10 ** 18) so
// rate 1 to 50 is 50 * 10 ** 18
// rate 50 to 1 is 1 / 50 * 10 ** 18 = 10 ** 18 / 50a
    return ((new BigNumber(10).pow(18)).mul(baseRate).floor());
};

function getExtraBpsForBuyQuantity(qty) {
    for (let i = 0; i < qtyBuyStepX.length; i++) {
        if (qty <= qtyBuyStepX[i]) return qtyBuyStepY[i];
    }
    return qtyBuyStepY[qtyBuyStepY.length - 1];
};

function getExtraBpsForSellQuantity(qty) {
    for (let i = 0; i < qtySellStepX.length; i++) {
        if (qty <= qtySellStepX[i]) return qtySellStepY[i];
    }
    return qtySellStepY[qtySellStepY.length - 1];
};

function getExtraBpsForImbalanceBuyQuantity(qty) {
    for (let i = 0; i < imbalanceBuyStepX.length; i++) {
        if (qty <= imbalanceBuyStepX[i]) return imbalanceBuyStepY[i];
    }
    return (imbalanceBuyStepY[imbalanceBuyStepY.length - 1]);
};

function getExtraBpsForImbalanceSellQuantity(qty) {
    for (let i = 0; i < imbalanceSellStepX.length; i++) {
        if (qty <= imbalanceSellStepX[i]) return imbalanceSellStepY[i];
    }
    return (imbalanceSellStepY[imbalanceSellStepY.length - 1]);
};

function addBps (price, bps) {
    return (price.mul(10000 + bps).div(10000));
};

function compareRates (receivedRate, expectedRate) {
    expectedRate = expectedRate - (expectedRate % 10);
    receivedRate = receivedRate - (receivedRate % 10);
    assert.equal(expectedRate, receivedRate, "different prices");
};

function calculateRateAmount(isBuy, tokenInd, srcQty, maxDestAmount) {
    let expectedRate;
    let expectedAmount;
    let baseArray;
    let imbalanceArray;
    let expected = [];

    imbalanceArray = reserveTokenImbalance;


    if (isBuy) {
        baseArray = baseBuyRate;
    } else {
        baseArray = baseSellRate;
    }

    if (isBuy) {
        expectedRate = (new BigNumber(baseArray[tokenInd]));
        let dstQty = calcDstQty(srcQty, 18, tokenDecimals[tokenInd], expectedRate);
        let extraBps = getExtraBpsForBuyQuantity(dstQty);
        expectedRate = addBps(expectedRate, extraBps);
        let relevantImbalance = imbalanceArray[tokenInd] * 1 + dstQty * 1;
        extraBps = getExtraBpsForImbalanceBuyQuantity(relevantImbalance);
        expectedRate = addBps(expectedRate, extraBps);
        expectedAmount = calcDstQty(srcQty, 18, tokenDecimals[tokenInd], expectedRate);
    } else {
        expectedRate = (new BigNumber(baseArray[tokenInd]));
        let extraBps = getExtraBpsForSellQuantity(srcQty);
        expectedRate = addBps(expectedRate, extraBps);
        let relevantImbalance = imbalanceArray[tokenInd] - srcQty;
        extraBps = getExtraBpsForImbalanceSellQuantity(relevantImbalance.valueOf());
        expectedRate = addBps(expectedRate, extraBps);
        expectedAmount = calcDstQty(srcQty, tokenDecimals[tokenInd], 18, expectedRate);
    }
    expectedAmount = expectedAmount.floor();
    expectedRate = expectedRate.floor();

    expected = [expectedRate, expectedAmount];
    return expected;
}


function calcDstQty(srcQty, srcDecimals, dstDecimals, rate) {
    rate = new BigNumber(rate);
    if (dstDecimals >= srcDecimals) {
        let decimalDiff = (new BigNumber(10)).pow(dstDecimals - srcDecimals);
        return (rate.mul(srcQty).mul(decimalDiff).div(precisionUnits)).floor();
    } else {
        let decimalDiff = (new BigNumber(10)).pow(srcDecimals - dstDecimals);
        return (rate.mul(srcQty).div(decimalDiff.mul(precisionUnits))).floor();
    }
}
