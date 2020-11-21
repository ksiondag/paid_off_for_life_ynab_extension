import * as ynab from "ynab";

let api: ynab.API;

export const login = async ({token}: { token: string }) => {
    let ret: { success: boolean, message: string } = { success: true, message: `` };
    localStorage.setItem(`token`, token);
    api = new ynab.API(token);
    return ret;
};

export const verify = (): boolean => {
    const token = localStorage.getItem(`token`);
    if (!!token && !api) {
        api = new ynab.API(token);
    }
    return !!token;
};

// TODO: don't export this later
export const getBudgets = async (): Promise<ynab.BudgetSummaryResponse> => {
    const localBudgets = localStorage.getItem(`budgets`)

    if (!!localBudgets) {
        return JSON.parse(localBudgets) as ynab.BudgetSummaryResponse;
    }

    const budgets = await api.budgets.getBudgets();
    localStorage.setItem(`budgets`, JSON.stringify(budgets));
    return budgets;
};

// TODO: don't export this later
export const getAccounts = async (budgetId: string): Promise<ynab.AccountsResponse> => {
    const localAccounts = localStorage.getItem(`accounts:${budgetId}`)

    if (!!localAccounts) {
        return JSON.parse(localAccounts) as ynab.AccountsResponse;
    }

    const accounts = await api.accounts.getAccounts(budgetId);
    localStorage.setItem(`accounts:${budgetId}`, JSON.stringify(accounts));
    return accounts;
};

const getMainAccounts = async (): Promise<ynab.AccountsResponse> => {
    const budgets = await getBudgets();
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    return getAccounts(mainBudget.id);
};

interface Account {
    id: string;
    name: string;
    balance: number;
};
export const poflAccounts = async (): Promise<Array<Account>> => {
    const mainAccounts = await getMainAccounts();
    const paidOffForLifeAccounts = mainAccounts.data.accounts.filter((a) => (!a.closed && a.type === ynab.Account.TypeEnum.OtherAsset) || a.name === `Paid Off for Life` || a.name === `Index Budgeted`);
    return paidOffForLifeAccounts;
};

export const budgetAccounts = async (): Promise<Array<Account>> => {
    const mainAccounts = await getMainAccounts();
    return mainAccounts.data.accounts.filter((a) => a.on_budget && (a.type === ynab.Account.TypeEnum.CreditCard) || a.name === "Chase Checking");
};

export const createTransactions = async (budegt_id: string, {transactions}: {transactions: Array<Omit<ynab.SaveTransaction, "date">>}) => {
    const now = new Date();
    await api.transactions.createTransactions(budegt_id, {transactions: transactions.map((t) => ({
        ...t,
        date: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
    }))});
    localStorage.removeItem(`accounts:${budegt_id}`);
};

// TODO: Break this script up and make it an interactive FE setup, add the updates to the
export const syncWithRealAccounts = async () => {
    const budgets = await getBudgets();

    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    const mainAccounts = await getAccounts(mainBudget.id);

    const investmentBudget = budgets.data.budgets.find((b) => b.name === 'Investment Accounts');
    const investmentAccounts = await getAccounts(investmentBudget.id);

    const paidOffForLifeAccounts = mainAccounts.data.accounts.filter((a) => !a.closed && (a.type === ynab.Account.TypeEnum.OtherAsset || a.name === `Paid Off for Life` || a.name === `Index Budgeted`));
    const paidOffForLifeTotal = paidOffForLifeAccounts.reduce((prev, a) => prev + a.balance, 0);
    const investmentsTotal = investmentAccounts.data.accounts.filter((a) => a.type === ynab.Account.TypeEnum.OtherAsset).reduce((prev, a) => prev + a.balance, 0);
    let delta = investmentsTotal - paidOffForLifeTotal;

    if (delta === 0) {
        return;
    }

    const interest = 1 - paidOffForLifeTotal/investmentsTotal;

    // TODO: Save lost money in 'Paid Off for Life' and 'Index Budgeted' and explicitly have paid off for life accounts make up for lost funds
    const transactions = paidOffForLifeAccounts.map((a) => {
        const amount =  Math.round(a.balance * interest / 10) * 10;
        delta -= amount;
        const now = new Date();
        return {
            account_id: a.id,
            amount,
            payee_name: "Market updates",
            // cleared: ynab.TransactionDetail.ClearedEnum.Cleared,
        };
    });

    transactions[0].amount += delta;

    createTransactions(mainBudget.id, {transactions});
};