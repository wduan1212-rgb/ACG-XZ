const normalize = value => String(value || "").trim().toLowerCase();

function accountSearchText(account = {}) {
  return normalize([
    account.name,
    account.username,
    account.platform,
    account.mode,
  ].filter(Boolean).join(" "));
}
function assetSearchText(row = {}, productLabel = "") {
  const asset = row.asset || {};
  const account = row.acc || {};
  return normalize([
    asset.title,
    asset.name,
    account.name,
    account.username,
    account.platform,
    asset.byAccount,
    asset.productTag || productLabel,
  ].filter(Boolean).join(" "));
}

export function buildSupplierSearchResults({
  accounts = [],
  delivered = [],
  query = "",
  productLabelFor = () => "",
} = {}) {
  const normalizedQuery = normalize(query);
  const matches = searchText => !normalizedQuery || searchText.includes(normalizedQuery);
  return {
    accounts: accounts
      .map(account => ({ account, searchText: accountSearchText(account) }))
      .filter(item => matches(item.searchText)),
    assets: delivered
      .map(row => ({
        ...row,
        searchText: assetSearchText(row, productLabelFor(row.asset)),
      }))
      .filter(item => matches(item.searchText)),
  };
}
