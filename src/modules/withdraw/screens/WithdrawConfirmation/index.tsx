import React, { useState } from 'react';
import { useIntl } from 'react-intl';

import { useTxBuilderContext } from '../../../../libs/tx-provider';
import { getAtokenInfo } from '../../../../helpers/get-atoken-info';
import Row from '../../../../components/basic/Row';
import NoDataPanel from '../../../../components/NoDataPanel';
import PoolTxConfirmationView from '../../../../components/PoolTxConfirmationView';
import Value from '../../../../components/basic/Value';
import HealthFactor from '../../../../components/HealthFactor';
import routeParamValidationHOC, {
  ValidationWrapperComponentProps,
} from '../../../../components/RouteParamsValidationWrapper';
import { isAssetStable } from '../../../../helpers/config/assets-config';

import defaultMessages from '../../../../defaultMessages';
import messages from './messages';
import { calculateHealthFactorFromBalancesBigUnits, valueToBigNumber } from '@aave/math-utils';
import BigNumber from 'bignumber.js';
import { useUserWalletDataContext } from '../../../../libs/web3-data-provider';
import { useAppDataContext } from '../../../../libs/pool-data-provider';

function WithdrawConfirmation({
  userReserve,
  poolReserve,
  amount,
  user,
  currencySymbol,
}: ValidationWrapperComponentProps) {
  const intl = useIntl();
  const { lendingPool } = useTxBuilderContext();
  const { currentAccount } = useUserWalletDataContext();
  const { userEmodeCategoryId } = useAppDataContext();

  const aTokenData = getAtokenInfo({
    address: poolReserve.underlyingAsset,
    symbol: currencySymbol,
    decimals: poolReserve.decimals,
    withFormattedSymbol: true,
  });

  const [isTxExecuted, setIsTxExecuted] = useState(false);

  if (!user) {
    return (
      <NoDataPanel
        title={intl.formatMessage(messages.connectWallet)}
        description={intl.formatMessage(messages.connectWalletDescription)}
        withConnectButton={true}
      />
    );
  }

  if (!userReserve || !amount) {
    return null;
  }

  const underlyingBalance = valueToBigNumber(userReserve.underlyingBalance);
  const unborrowedLiquidity = valueToBigNumber(poolReserve.unborrowedLiquidity);
  let maxAmountToWithdraw = BigNumber.min(underlyingBalance, unborrowedLiquidity);
  let maxCollateralToWithdrawInETH = valueToBigNumber('0');
  const reserveLiquidationThreshold =
    userEmodeCategoryId === poolReserve.eModeCategoryId
      ? poolReserve.formattedEModeLiquidationThreshold
      : poolReserve.formattedReserveLiquidationThreshold;
  if (
    userReserve.usageAsCollateralEnabledOnUser &&
    poolReserve.usageAsCollateralEnabled &&
    user.totalBorrowsMarketReferenceCurrency !== '0'
  ) {
    // if we have any borrowings we should check how much we can withdraw without liquidation
    // with 0.5% gap to avoid reverting of tx
    const excessHF = valueToBigNumber(user.healthFactor).minus('1');
    if (excessHF.gt('0')) {
      maxCollateralToWithdrawInETH = excessHF
        .multipliedBy(user.totalBorrowsMarketReferenceCurrency)
        // because of the rounding issue on the contracts side this value still can be incorrect
        .div(Number(reserveLiquidationThreshold) + 0.01)
        .multipliedBy('0.99');
    }
    maxAmountToWithdraw = BigNumber.min(
      maxAmountToWithdraw,
      maxCollateralToWithdrawInETH.dividedBy(poolReserve.formattedPriceInMarketReferenceCurrency)
    );
  }

  let amountToWithdraw = amount;
  let displayAmountToWithdraw = amount;

  if (amountToWithdraw.eq('-1')) {
    if (user.totalBorrowsMarketReferenceCurrency !== '0') {
      if (!maxAmountToWithdraw.eq(underlyingBalance)) {
        amountToWithdraw = maxAmountToWithdraw;
      }
    }
    displayAmountToWithdraw = maxAmountToWithdraw;
  }

  let blockingError = '';
  let totalCollateralInETHAfterWithdraw = valueToBigNumber(
    user.totalCollateralMarketReferenceCurrency
  );
  let liquidationThresholdAfterWithdraw = user.currentLiquidationThreshold;
  let healthFactorAfterWithdraw = valueToBigNumber(user.healthFactor);

  if (userReserve.usageAsCollateralEnabledOnUser && poolReserve.usageAsCollateralEnabled) {
    const amountToWithdrawInEth = displayAmountToWithdraw.multipliedBy(
      poolReserve.formattedPriceInMarketReferenceCurrency
    );
    totalCollateralInETHAfterWithdraw =
      totalCollateralInETHAfterWithdraw.minus(amountToWithdrawInEth);

    liquidationThresholdAfterWithdraw = valueToBigNumber(
      user.totalCollateralMarketReferenceCurrency
    )
      .multipliedBy(user.currentLiquidationThreshold)
      .minus(valueToBigNumber(amountToWithdrawInEth).multipliedBy(reserveLiquidationThreshold))
      .div(totalCollateralInETHAfterWithdraw)
      .toFixed(4, BigNumber.ROUND_DOWN);

    healthFactorAfterWithdraw = calculateHealthFactorFromBalancesBigUnits({
      collateralBalanceMarketReferenceCurrency: totalCollateralInETHAfterWithdraw,
      borrowBalanceMarketReferenceCurrency: user.totalBorrowsMarketReferenceCurrency,
      currentLiquidationThreshold: liquidationThresholdAfterWithdraw,
    });

    if (healthFactorAfterWithdraw.lt('1') && user.totalBorrowsMarketReferenceCurrency !== '0') {
      blockingError = intl.formatMessage(messages.errorCanNotWithdrawThisAmount);
    }
  }

  if (
    !blockingError &&
    (underlyingBalance.eq('0') || underlyingBalance.lt(displayAmountToWithdraw))
  ) {
    blockingError = intl.formatMessage(messages.errorYouDoNotHaveEnoughFundsToWithdrawThisAmount);
  }
  if (
    !blockingError &&
    (unborrowedLiquidity.eq('0') || displayAmountToWithdraw.gt(poolReserve.unborrowedLiquidity))
  ) {
    blockingError = intl.formatMessage(messages.errorPoolDoNotHaveEnoughFundsToWithdrawThisAmount);
  }

  const handleGetTransactions = async () => {
    return await lendingPool.withdraw({
      user: currentAccount,
      reserve: poolReserve.underlyingAsset,
      amount: amountToWithdraw.toString(),
      aTokenAddress: poolReserve.aTokenAddress,
    });
  };

  const handleMainTxExecuted = () => setIsTxExecuted(true);

  const isHealthFactorDangerous =
    user.totalBorrowsMarketReferenceCurrency !== '0' &&
    healthFactorAfterWithdraw.toNumber() <= 1.05;

  return (
    <PoolTxConfirmationView
      mainTxName={intl.formatMessage(defaultMessages.withdraw)}
      caption={intl.formatMessage(messages.caption)}
      boxTitle={intl.formatMessage(defaultMessages.withdraw)}
      boxDescription={intl.formatMessage(messages.boxDescription)}
      approveDescription={intl.formatMessage(messages.approveDescription)}
      getTransactionsData={handleGetTransactions}
      onMainTxExecuted={handleMainTxExecuted}
      blockingError={blockingError}
      dangerousMessage={
        isHealthFactorDangerous
          ? intl.formatMessage(messages.healthFactorDangerousText, {
              liquidation: <span>{intl.formatMessage(messages.liquidation)}</span>,
            })
          : ''
      }
      aTokenData={aTokenData}
    >
      <Row title={intl.formatMessage(messages.rowTitle)} withMargin={+user.healthFactor > 0}>
        <Value
          symbol={currencySymbol}
          value={displayAmountToWithdraw.toString()}
          tokenIcon={true}
          maximumValueDecimals={isAssetStable(currencySymbol) ? 4 : 18}
          updateCondition={isTxExecuted}
          tooltipId={currencySymbol}
        />
      </Row>

      {+user.healthFactor > 0 && (
        <>
          <HealthFactor
            title={intl.formatMessage(messages.currentHealthFactor)}
            value={user.healthFactor}
            updateCondition={isTxExecuted}
            titleColor="dark"
          />
          <HealthFactor
            title={intl.formatMessage(messages.nextHealthFactor)}
            value={healthFactorAfterWithdraw.toString()}
            withTextShadow={isHealthFactorDangerous}
            updateCondition={isTxExecuted}
            withoutModal={true}
            titleColor="dark"
          />
        </>
      )}
    </PoolTxConfirmationView>
  );
}

export default routeParamValidationHOC({
  withAmount: true,
  withUserReserve: true,
  allowLimitAmount: true,
})(WithdrawConfirmation);
