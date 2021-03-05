import * as ynab from "ynab";
import { TransactionSummary } from "ynab";

let api: ynab.API;

export type Account = ynab.Account;
export type SaveTransaction = ynab.SaveTransaction;
export type BudgetSummary = ynab.BudgetSummary;

const ONE_HOUR = 1000 * 60 * 60;

const resetIfStale = () => {
    const lastCache = localStorage.getItem(`lastCache`);

    if (!lastCache || Date.now() - Number(lastCache) > ONE_HOUR) {
        const token = localStorage.getItem(`token`);
        localStorage.clear();
        localStorage.setItem(`token`, token);
        localStorage.setItem(`lastCache`, (Date.now()).toString())
    }
};

export const login = async ({ token }: { token: string }) => {
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

export const getBudgets = async (): Promise<ynab.BudgetSummaryResponse> => {
    resetIfStale();
    const localBudgets = localStorage.getItem(`budgets`)

    if (!!localBudgets) {
        return JSON.parse(localBudgets) as ynab.BudgetSummaryResponse;
    }

    const budgets = await api.budgets.getBudgets();
    localStorage.setItem(`budgets`, JSON.stringify(budgets));
    return budgets;
};

export const getAccounts = async (budgetId: string): Promise<ynab.Account[]> => {
    resetIfStale();
    const localAccounts = localStorage.getItem(`accounts:${budgetId}`)

    if (!!localAccounts) {
        return JSON.parse(localAccounts) as ynab.Account[];
    }

    const accounts = (await api.accounts.getAccounts(budgetId)).data.accounts;
    localStorage.setItem(`accounts:${budgetId}`, JSON.stringify(accounts));
    return accounts;
};

const getMainAccounts = async (): Promise<ynab.Account[]> => {
    const budgets = await getBudgets();
    // TODO: no hardcoded budget or account names
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    return getAccounts(mainBudget.id);
};

export const poflAccounts = async (): Promise<Array<Account>> => {
    const mainAccounts = await getMainAccounts();
    const paidOffForLifeAccounts = mainAccounts.filter((a) => (!a.closed && a.type === ynab.Account.TypeEnum.OtherAsset) || a.name === `Index Budgeted`);

    /** DELETE LATER */
    // const budgets = await getBudgets();
    // const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    // getTransactions(mainBudget.id, paidOffForLifeAccounts[1].id);
    /** END DELETE */

    return paidOffForLifeAccounts;
};

export const assetAccounts = async (): Promise<Array<Account>> => {
    const budgets = await getBudgets();
    // TODO: no hardcoded budget or account names
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'Investment Accounts');
    return (await getAccounts(mainBudget.id)).filter((a) => a.type === ynab.Account.TypeEnum.OtherAsset);
}

export const budgetAccounts = async (): Promise<Array<Account>> => {
    const mainAccounts = await getMainAccounts();
    return mainAccounts.filter((a) => a.on_budget && (a.type === ynab.Account.TypeEnum.CreditCard) || a.name === "Chase Checking");
};

export const getTransactions = async (budget_id: string, account_id: string): Promise<ynab.TransactionDetail[]> => {
    resetIfStale();
    const localTransactions = localStorage.getItem(`transactions:${budget_id}:${account_id}`)

    if (!!localTransactions) {
        return JSON.parse(localTransactions) as ynab.TransactionDetail[];
    }

    const transactions = (await api.transactions.getTransactionsByAccount(budget_id, account_id)).data.transactions;
    localStorage.setItem(`transactions:${budget_id}:${account_id}`, JSON.stringify(transactions));
    return transactions;
};

export const createTransactions = async (budget_id: string, { transactions }: { transactions: Array<Omit<ynab.SaveTransaction, "date"> | ynab.SaveTransaction> }) => {
    await api.transactions.createTransactions(budget_id, {
        transactions: transactions.map((t) => ({
            date: ynab.utils.getCurrentDateInISOFormat(),
            ...t,
        }))
    });
    localStorage.removeItem(`accounts:${budget_id}`);
};

const getCategories = async (budget_id: string): Promise<ynab.CategoryGroupWithCategories[]> => {
    resetIfStale();
    const localCategories = localStorage.getItem(`categories:${budget_id}`)

    if (!!localCategories) {
        return JSON.parse(localCategories) as ynab.CategoryGroupWithCategories[];
    }

    const categories = (await api.categories.getCategories(budget_id)).data.category_groups;
    localStorage.setItem(`categories:${budget_id}`, JSON.stringify(categories));
    return categories;
};

const calculateSubtransactions = (amount: number, account: Account, categories: ynab.CategoryGroupWithCategories[]): ynab.SaveSubTransaction[] => {
    const accountCategories = categories.flatMap((group) => group.categories.filter((category) => category.note?.includes(account.name)));
    if (accountCategories.length === 0) {
        return [];
    }
    const overflowCategory = accountCategories.find((c) => c.note?.includes(`Overflow`));
    const categoryObj = overflowCategory ? { category_id: overflowCategory.id } : {};

    const interest = 1 - account.balance / (account.balance + amount);
    let delta = amount;
    const subtransactions: ynab.SaveSubTransaction[] = [{
        ...categoryObj,
        amount: 0,
    }, ...accountCategories.filter((c) => c.id !== overflowCategory.id && c.note?.includes(`Compound`)).map((c) => {
        const amount = Math.round(c.balance * interest / 10) * 10;
        delta -= amount;
        return {
            category_id: c.id,
            amount,
        };
    })];
    subtransactions[0].amount += delta;
    return subtransactions.filter((s) => s.amount !== 0);
};

export const rules = ({ note }: { note?: string }) => {
    const rules = (note ? note.split(`\n`) : []).filter(rule => rule.startsWith(`POFL: `));
    const ret: {
        inflate: boolean,
        deflate: boolean,
        withdrawalAmount?: number,
        overflow: boolean,
    } = {
        inflate: false,
        deflate: false,
        overflow: false,
    }

    let setAmount;
    for (const index in rules) {
        const rule = rules[index];

        if (rule.search("Inflate") !== -1) {
            ret.inflate = true;
        }

        if (rule.search("Deflate") !== -1) {
            ret.deflate = true;
        }

        if (rule.search("Overflow") !== -1) {
            ret.overflow = true;
        }

        setAmount = setAmount ? setAmount : rule.match(/[0-9]+/);
    }

    if (setAmount) {
        ret.withdrawalAmount = Number(setAmount) * 1000;
    }

    return ret;
};

// TODO: Break this script up and make it an interactive FE setup
export const syncWithRealAccounts = async () => {
    const budgets = await getBudgets();

    // TODO: no hardcoded budget or account names
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    const mainAccounts = await getAccounts(mainBudget.id);

    // TODO: no hardcoded budget or account names
    const investmentBudget = budgets.data.budgets.find((b) => b.name === 'Investment Accounts');
    const investmentAccounts = await getAccounts(investmentBudget.id);

    const paidOffForLifeAccounts = mainAccounts.filter((a) => !a.closed && (a.type === ynab.Account.TypeEnum.OtherAsset || a.name === `Index Budgeted`));
    const paidOffForLifeTotal = paidOffForLifeAccounts.reduce((prev, a) => prev + a.balance, 0);
    const investmentsTotal = investmentAccounts.filter((a) => a.type === ynab.Account.TypeEnum.OtherAsset).reduce((prev, a) => prev + a.balance, 0);
    let delta = investmentsTotal - paidOffForLifeTotal;

    if (delta === 0) {
        return;
    }

    const interest = 1 - paidOffForLifeTotal / investmentsTotal;
    const categories = await getCategories(mainBudget.id);
    const transactions = paidOffForLifeAccounts.map((a): Omit<ynab.SaveTransaction, "date"> => {
        const amount = Math.round(a.balance * interest / 10) * 10;
        delta -= amount;
        const subtransactions = calculateSubtransactions(amount, a, categories);
        const subtransactionObj = subtransactions.length > 0 ? { subtransactions } : {};
        return {
            account_id: a.id,
            amount,
            payee_name: "Market updates",
            ...subtransactionObj,
        };
    }).filter((t) => t.amount !== 0);

    transactions[0].amount += delta;
    if (transactions[0].subtransactions) {
        transactions[0].subtransactions[0].amount += delta;
    }

    createTransactions(mainBudget.id, { transactions });
};

export const handleOverflow = async () => {
    const budgets = await getBudgets();

    // TODO: no hardcoded budget or account names
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    const mainAccounts = (await getAccounts(mainBudget.id)).filter((a) => !a.closed && a.type === ynab.Account.TypeEnum.OtherAsset);

    const paidOffForLifeAccounts = mainAccounts.filter((a) => (
        !a.closed
        && a.type === ynab.Account.TypeEnum.OtherAsset
        && rules(a).overflow
        && !!rules(a).withdrawalAmount
    ));

    const overflowAccount = mainAccounts[0];

    const transactions = paidOffForLifeAccounts.map((a): Omit<ynab.SaveTransaction, "date"> => {
        const r = rules(a);

        const excess = a.balance - r.withdrawalAmount * 300;
        // TODO: need to look at what transfer transactions look like
        return {
            account_id: a.id,
            amount: -excess,
            payee_id: overflowAccount.transfer_payee_id,
        }
    }).filter((t) => t.amount < 0);

    // TODO: create transactions in one lump
    // createTransactions(mainBudget.id, { transactions });

    return transactions;
};

const updateAmount = (transaction: ynab.TransactionDetail, accounts: ynab.Account[]) => {
    const account = accounts.find((a) => a.transfer_payee_id === transaction.payee_id);
    const r = rules(account);

    const safeWithdrawal = Math.floor(account.balance / 3000) * 10;
    let amount = transaction.amount;
    if (r.inflate && transaction.amount < safeWithdrawal) {
        amount = safeWithdrawal;
    } else if (r.deflate && transaction.amount > safeWithdrawal) {
        amount = safeWithdrawal;
    } else if (r.withdrawalAmount) {
        amount = r.withdrawalAmount;
    }
    return amount;
};

export const handleDynamicWithdrawalAmounts = async () => {
    const budgets = await getBudgets();

    // TODO: no hardcoded budget or account names
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    const mainAccounts = (await getAccounts(mainBudget.id)).filter((a) => !a.closed && a.type === ynab.Account.TypeEnum.OtherAsset);

    const paidOffForLifeAccounts = mainAccounts.filter((a) => (
        !a.closed
        && a.type === ynab.Account.TypeEnum.OtherAsset
        && (rules(a).inflate || rules(a).deflate)
    ));

    // TODO: get already existing transaction for current and next month
    // TODO: update amount based on inflation/deflation/withdrawal amount
    // TODO: undo hard-coded values
    const transactions = (await api.transactions.getTransactions(mainBudget.id, "2021-03-01")).data.transactions
        .filter((t) => paidOffForLifeAccounts.map((a) => a.transfer_payee_id).includes(t.payee_id))
        .map((t): ynab.UpdateTransaction => ({
            id: t.id,
            account_id: t.account_id,
            date: t.date,
            amount: updateAmount(t, paidOffForLifeAccounts),
        }));

    console.log(transactions);

    // TODO: create transactions in one lump
    // createTransactions(mainBudget.id, { transactions });
    return transactions;
};

export const updatePoflTransfers = async () => {
    const budgets = await getBudgets();

    // TODO: no hardcoded budget or account names
    const mainBudget = budgets.data.budgets.find((b) => b.name === 'My Budget');
    const mainAccounts = (await getAccounts(mainBudget.id)).filter((a) => !a.closed && a.type === ynab.Account.TypeEnum.OtherAsset || a.name === `Index Budgeted`);

    const paidOffForLifeAccounts = mainAccounts.filter((a) => (
        !a.closed
        && a.type === ynab.Account.TypeEnum.OtherAsset
        && (rules(a).inflate || rules(a).deflate)
    ));

    const indexBudgettedAcount = mainAccounts[0];

    const transactions = paidOffForLifeAccounts.map((a): Omit<ynab.SaveTransaction, "date"> => {
        const r = rules(a);

        const excess = a.balance - r.withdrawalAmount * 300;
        // TODO: need to look at what transfer transactions look like
        return {
            account_id: indexBudgettedAcount.id,
            amount: -excess,
            payee_id: a.transfer_payee_id,
        }
    }).filter((t) => t.amount < 0);

    createTransactions(mainBudget.id, { transactions });
};

export const toString = (balance: number): string => {
    return (balance / 1000).toLocaleString(undefined, { minimumFractionDigits: 2 });
};

export const toNumber = (balance: string): number => {
    // TODO: needs to be area agnostic (use built-in thing to find character)
    return Number(balance.replace(/,/g, ``).replace(/\./g, ``)) * 10;
};

export const createAccount = async (budget_id: string, account_name: string) => {
    const response = await api.accounts.createAccount(budget_id, {
        account: {
            name: account_name,
            type: ynab.Account.TypeEnum.OtherAsset as ynab.SaveAccount.TypeEnum,
            balance: 0,
        },
    });

    return response.data.account;
};